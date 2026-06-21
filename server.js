require('dotenv').config();
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');
const cron  = require('node-cron');
const { searchNellis, closeBrowser } = require('./scraper');
const notifier = require('./notifier');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const PORT           = parseInt(process.env.PORT || '3010');
const SCAN_CRON      = process.env.SCAN_CRON || '50 16 * * *'; // 4:50 PM — before auctions open at 5 PM
const DATA_DIR       = process.env.DATA_DIR || __dirname;
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

// ── State ────────────────────────────────────────────────────
function loadWatchlist() {
  try { return fs.existsSync(WATCHLIST_FILE) ? JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')) : []; }
  catch { return []; }
}
function saveWatchlist() {
  try { fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2)); } catch { /* ok */ }
}

let watchlist = loadWatchlist(); // [{ id, kw, th, cat }]
let liveItems = [];              // current auction items from Nellis
const alerted   = new Set();    // items where alert was fired
const discarded = new Set();    // items dropped because price > threshold at 10-min mark

// ── Mock data (used when MOCK_MODE=true or scrape fails on first run) ──
function getMockItems(keyword, maxPrice) {
  const now = Date.now();
  const pool = [
    { id:'m1', title:`Vintage Rolex Submariner — "${keyword}" match`,   category:'watches',      price:4.50, end:now+28000,    url:'https://www.nellisauction.com', img:'' },
    { id:'m2', title:`Apple MacBook Pro M2 — "${keyword}" result`,      category:'electronics',  price:3.75, end:now+162000,   url:'https://www.nellisauction.com', img:'' },
    { id:'m3', title:`Jordan Card PSA 9 — "${keyword}" listing`,        category:'collectibles', price:2.00, end:now+7200000,  url:'https://www.nellisauction.com', img:'' },
    { id:'m4', title:`Nike Air Jordan 1 — "${keyword}" DS`,             category:'fashion',      price:1.00, end:now+86400000, url:'https://www.nellisauction.com', img:'' },
    { id:'m5', title:`Bose QC45 Headphones — "${keyword}" auction`,     category:'electronics',  price:4.99, end:now+52000,    url:'https://www.nellisauction.com', img:'' },
  ];
  return pool
    .filter(i => i.title.toLowerCase().includes(keyword.toLowerCase()) || Math.random() > 0.4)
    .filter(i => i.price <= maxPrice)
    .slice(0, 3);
}

const MOCK_MODE = process.env.MOCK_MODE === 'true';

// ── Scanner ──────────────────────────────────────────────────
let scanInProgress = false;

async function runScan(targetKeyword = null) {
  if (scanInProgress) { console.log('[scan] already running — skipped'); return; }
  scanInProgress = true;

  const targets = targetKeyword
    ? watchlist.filter(w => w.kw === targetKeyword)
    : watchlist;

  if (!targets.length) { scanInProgress = false; return; }

  console.log(`[scan] ${new Date().toISOString()} — ${targets.length} keyword(s)`);
  broadcast({ type: 'scan_start', ts: Date.now() });

  const fresh = [];
  const seen  = new Set();

  for (const w of targets) {
    // Jitter between keywords so requests don't fire in a machine-regular cadence
    if (fresh.length > 0) {
      const jitterMs = 8000 + Math.random() * 12000; // 8–20 s between keywords
      console.log(`[scan] waiting ${Math.round(jitterMs / 1000)}s before next keyword…`);
      await new Promise(r => setTimeout(r, jitterMs));
    }

    try {
      const items = MOCK_MODE
        ? getMockItems(w.kw, w.th)
        : await searchNellis(w.kw, w.th);

      items.forEach(item => {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          fresh.push({ ...item, wid: w.id, th: w.th, keyword: w.kw });
        }
      });

      broadcast({ type: 'keyword_done', keyword: w.kw, count: items.length });
    } catch (err) {
      console.error(`[scan] "${w.kw}" failed:`, err.message);
    }
  }

  // Merge: keep existing items not re-scanned (other keywords), replace scanned ones
  if (targetKeyword) {
    const wid = targets[0]?.id;
    liveItems = [...liveItems.filter(i => i.wid !== wid), ...fresh];
  } else {
    liveItems = fresh;
  }

  broadcast({ type: 'scan_complete', items: liveItems, ts: Date.now() });
  console.log(`[scan] Done — ${liveItems.length} total items`);
  scanInProgress = false;
}

// ── Alert Monitor (every 15 s — checks local cache only, no web request) ──
// At 10-min mark: alert if price ≤ threshold, discard if price > threshold.
function checkAlerts() {
  const now = Date.now();
  let changed = false;

  liveItems.forEach(item => {
    const rem = item.end - now;
    if (rem <= 0 || alerted.has(item.id) || discarded.has(item.id)) return;

    if (rem <= 600_000) { // within 10 minutes
      if (item.price <= item.th) {
        alerted.add(item.id);
        broadcast({ type: 'alert', item });
        console.log(`[alert] "${item.title.slice(0, 50)}" — $${item.price} — ${Math.floor(rem / 1000)}s left — ${item.url}`);
        notifier.sendAlert(item).catch(e => console.error('[notifier]', e.message));
      } else {
        discarded.add(item.id);
        broadcast({ type: 'discard', item });
        console.log(`[discard] "${item.title.slice(0, 50)}" — $${item.price} > $${item.th} — dropped`);
        changed = true;
      }
    }
  });

  if (changed) {
    liveItems = liveItems.filter(i => !discarded.has(i.id));
    broadcast({ type: 'scan_complete', items: liveItems, ts: Date.now() });
  }
}

// ── Price refresh for soon-ending items ──────────────────────
// Re-scrapes only items ending within 90 minutes, every 5 minutes.
// This keeps prices accurate without full daily-scan overhead.
let refreshInProgress = false;
async function refreshSoonEnding() {
  if (refreshInProgress || scanInProgress || MOCK_MODE) return;
  const soonEnding = liveItems.filter(i => {
    const rem = i.end - Date.now();
    return rem > 0 && rem <= 90 * 60 * 1000;
  });
  if (!soonEnding.length) return;

  refreshInProgress = true;
  const keywords = [...new Set(soonEnding.map(i => i.keyword))];
  console.log(`[refresh] updating ${keywords.length} soon-ending keyword(s): ${keywords.join(', ')}`);

  for (const kw of keywords) {
    const w = watchlist.find(x => x.kw === kw);
    if (!w) continue;
    if (keywords.indexOf(kw) > 0) await new Promise(r => setTimeout(r, 6000 + Math.random() * 8000));
    try {
      const fresh = await searchNellis(w.kw, w.th);
      // Merge: update matching items in liveItems
      fresh.forEach(fi => {
        const idx = liveItems.findIndex(i => i.id === fi.id);
        if (idx !== -1) liveItems[idx] = { ...liveItems[idx], price: fi.price, end: fi.end };
        else liveItems.push({ ...fi, wid: w.id, th: w.th, keyword: w.kw });
      });
      broadcast({ type: 'scan_complete', items: liveItems, ts: Date.now() });
    } catch (e) { console.error('[refresh]', e.message); }
  }
  refreshInProgress = false;
}

// ── WebSocket ────────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── HTTP Server ──────────────────────────────────────────────
function sendJSON(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end',  () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  // ── UI ──
  if (url === '/' || url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // ── GET /api/watchlist ──
  if (url === '/api/watchlist' && req.method === 'GET')
    return sendJSON(res, 200, watchlist);

  // ── POST /api/watchlist ──
  if (url === '/api/watchlist' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJSON(res, 400, { error: 'bad body' });
    const item = { ...body, id: Date.now() };
    watchlist.push(item);
    saveWatchlist();
    sendJSON(res, 201, item);
    // Immediate scan for just this keyword (non-blocking)
    setTimeout(() => runScan(item.kw), 500);
    return;
  }

  // ── DELETE /api/watchlist/:id ──
  if (url.startsWith('/api/watchlist/') && req.method === 'DELETE') {
    const id   = parseInt(url.split('/').pop());
    watchlist  = watchlist.filter(w => w.id !== id);
    liveItems  = liveItems.filter(i => i.wid !== id);
    saveWatchlist();
    broadcast({ type: 'scan_complete', items: liveItems, ts: Date.now() });
    return sendJSON(res, 200, { ok: true });
  }

  // ── GET /api/items ──
  if (url === '/api/items' && req.method === 'GET')
    return sendJSON(res, 200, liveItems);

  // ── POST /api/scan  (manual trigger) ──
  if (url === '/api/scan' && req.method === 'POST') {
    sendJSON(res, 202, { queued: true });
    setTimeout(runScan, 100);
    return;
  }

  // ── POST /api/scan-cron  (reschedule daily scan) ──
  if (url === '/api/scan-cron' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body || body.hour === undefined || body.min === undefined)
      return sendJSON(res, 400, { error: 'need hour + min' });
    const h = parseInt(body.hour), m = parseInt(body.min);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59)
      return sendJSON(res, 400, { error: 'invalid hour/min' });
    const cronExpr = `${m} ${h} * * *`;
    rescheduleDailyScan(cronExpr);
    return sendJSON(res, 200, { cron: cronExpr });
  }

  // ── POST /api/chat  (AI assistant — SSE streaming) ──
  if (url === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    const sseHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    };
    if (!body || !body.message) { res.writeHead(400); return res.end(); }
    if (!anthropic) {
      res.writeHead(200, sseHeaders);
      res.write(`data: ${JSON.stringify({ t: '⚠️  Set ANTHROPIC_API_KEY in your .env file to enable AI chat.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const now = Date.now();
    const ctxItems = liveItems.slice(0, 30).map(i => ({
      title: i.title,
      price: `$${i.price.toFixed(2)}`,
      threshold: `$${(i.th || 0).toFixed(2)}`,
      timeLeft: i.end > now ? `${Math.round((i.end - now) / 1000)}s` : 'ENDED',
      dealScore: i.th > 0 ? `${Math.round(((i.th - i.price) / i.th) * 100)}%` : 'n/a',
      url: i.url,
      category: i.category || 'misc',
    }));
    const ctxWatches = watchlist.map(w => ({ keyword: w.kw, maxPrice: `$${w.th.toFixed(2)}`, category: w.cat }));
    const system = `You are AuctionWatch AI — an expert auction strategist embedded in a real-time Nellis Auction bid-sniping tool.

LIVE AUCTION DATA (as of ${new Date().toLocaleString()}):
Watchlist: ${JSON.stringify(ctxWatches)}
Live Items: ${JSON.stringify(ctxItems)}

Your role: help the user win great deals. Be concise and direct. Use **bold** for prices and key terms. Use bullet points for lists. Flag urgency when items are ending soon (< 5 min). Never invent data not in the context above. If the watchlist is empty, encourage the user to add keywords.`;

    const history = (body.history || []).slice(-10).map(m => ({ role: m.role, content: m.content }));
    const messages = [...history, { role: 'user', content: body.message }];

    res.writeHead(200, sseHeaders);
    try {
      const stream = anthropic.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 600,
        system,
        messages,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
        }
      }
    } catch (err) {
      console.error('[chat]', err.message);
      const msg = err.status === 401
        ? '⚠️  Invalid API key — check ANTHROPIC_API_KEY in .env.'
        : '⚠️  AI unavailable — try again in a moment.';
      res.write(`data: ${JSON.stringify({ t: msg })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // ── POST /api/test-alert  (fires a test notification) ──
  if (url === '/api/test-alert' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    const item = body || { id: 'test', title: 'TEST — AuctionWatch Alert', price: 1.99, th: 5.00, end: Date.now() + 45000, url: 'https://www.nellisauction.com' };
    notifier.sendAlert(item).catch(e => console.error('[notifier]', e.message));
    return sendJSON(res, 200, { queued: true });
  }

  // ── GET /api/notifications ──
  if (url === '/api/notifications' && req.method === 'GET')
    return sendJSON(res, 200, notifier.loadConfig());

  // ── POST /api/notifications ──
  if (url === '/api/notifications' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJSON(res, 400, { error: 'bad body' });
    const cfg = { email: body.email || '', phone: body.phone || '' };
    notifier.saveConfig(cfg);
    return sendJSON(res, 200, cfg);
  }

  res.writeHead(404); res.end();
});

// ── WebSocket Server ─────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', items: liveItems, watchlist }));
  ws.on('close',   () => clients.delete(ws));
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'scan') runScan();
  });
});

// ── Schedules ────────────────────────────────────────────────
// Daily full scan — jitter ±5 min so requests don't land at :00 exactly
let cronTask = cron.schedule(SCAN_CRON, () => {
  const jitter = Math.random() * 5 * 60 * 1000;
  setTimeout(runScan, jitter);
});

function rescheduleDailyScan(cronExpr) {
  cronTask.stop();
  cronTask = cron.schedule(cronExpr, () => {
    const jitter = Math.random() * 5 * 60 * 1000;
    setTimeout(runScan, jitter);
  });
  console.log(`[cron] rescheduled: ${cronExpr}`);
}

setInterval(checkAlerts,     15_000);      // alert check: every 15 s (local only)
setInterval(refreshSoonEnding, 5 * 60_000); // price refresh: every 5 min for ending items

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown() {
  console.log('\n[server] shutting down…');
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n⚡ AuctionWatch — NellisAuction monitor`);
  console.log(`   UI          → http://localhost:${PORT}`);
  console.log(`   Mode        : ${MOCK_MODE ? 'MOCK (set MOCK_MODE=false to go live)' : 'LIVE (Playwright/Nellis)'}`);
  console.log(`   Daily scan  : ${SCAN_CRON}  (±5 min jitter)`);
  console.log(`   Alert gate  : price ≤ threshold AND ≤ 10 min remaining → alert; price > threshold → discard`);
  console.log(`   Price refresh: every 5 min for items ending within 90 min\n`);
});
