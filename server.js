require('dotenv').config();
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');
const cron  = require('node-cron');
const { searchNellis, closeBrowser } = require('./scraper');

const PORT      = parseInt(process.env.PORT || '3010');
const SCAN_CRON = process.env.SCAN_CRON || '0 8 * * *';

// ── State ────────────────────────────────────────────────────
let watchlist = [];   // [{ id, kw, th, cat }]
let liveItems = [];   // current auction items from Nellis
const alerted = new Set();

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
function checkAlerts() {
  const now = Date.now();
  liveItems.forEach(item => {
    const rem = item.end - now;
    if (rem > 0 && rem <= 60_000 && item.price <= item.th && !alerted.has(item.id)) {
      alerted.add(item.id);
      broadcast({ type: 'alert', item });
      console.log(`[alert] "${item.title.slice(0, 50)}" — $${item.price} — ${Math.floor(rem / 1000)}s left — ${item.url}`);
    }
  });
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
cron.schedule(SCAN_CRON, () => {
  const jitter = Math.random() * 5 * 60 * 1000;
  setTimeout(runScan, jitter);
});

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
  console.log(`   Alert gate  : price ≤ threshold AND ≤ 60s remaining`);
  console.log(`   Price refresh: every 5 min for items ending within 90 min\n`);
});
