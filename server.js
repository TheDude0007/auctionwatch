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
const SCAN_CRON      = process.env.SCAN_CRON || '0 16 * * *'; // 4:00 PM daily keyword scan
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

// Keyword match: supports both legacy {kw} and new {kws, mode, minMatch}
function matchesKeywords(title, w) {
  const kws = w.kws || (w.kw ? [w.kw] : []);
  if (!kws.length) return true;
  const t = title.toLowerCase();
  const hits = kws.filter(k => t.includes(k.toLowerCase())).length;
  return w.mode === 'some' ? hits >= (w.minMatch || Math.ceil(kws.length / 2)) : hits === kws.length;
}

let watchlist = loadWatchlist(); // [{ id, kws[], mode, minMatch, th, tw, cat }]
let liveItems = [];              // current auction items from Nellis
const alerted   = new Set();    // items where alert was fired
const discarded = new Set();    // items dropped because price > threshold at 10-min mark

// ── Mock data pool (used when MOCK_MODE=true) ──
const MOCK_POOL = [
  // Electronics
  { id:'m01', title:'Apple MacBook Pro M3 16" Space Gray 36GB',     category:'electronics',  price:245.00, end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m02', title:'Apple MacBook Air M2 13" Midnight 8GB 256GB',  category:'electronics',  price:88.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m03', title:'Bose QuietComfort 45 Wireless Headphones Black',category:'electronics',  price:22.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m04', title:'Bose SoundLink Flex Bluetooth Speaker Stone Blue',category:'electronics', price:18.75,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m05', title:'Sony WH-1000XM5 Noise Cancelling Headphones',  category:'electronics',  price:31.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m06', title:'Apple iPad Pro 12.9" M2 Wi-Fi 256GB Silver',   category:'electronics',  price:175.00, end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m07', title:'Samsung 65" QLED 4K Smart TV QN65Q80C',        category:'electronics',  price:310.00, end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m08', title:'Dell XPS 15 Intel i9 RTX 4060 1TB Laptop',     category:'electronics',  price:195.00, end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  // Watches & Jewelry
  { id:'m09', title:'Rolex Submariner Date 116610LN Black Dial',     category:'watches',      price:38.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m10', title:'Rolex Datejust 41 126300 Jubilee Bracelet',     category:'watches',      price:29.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m11', title:'Omega Seamaster 300M Co-Axial Master Chronometer',category:'watches',    price:41.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m12', title:'TAG Heuer Carrera Chronograph 43mm Stainless',  category:'watches',      price:19.25,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  // Collectibles
  { id:'m13', title:'Michael Jordan 1986 Fleer Rookie PSA 7',        category:'collectibles', price:14.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m14', title:'Nike Air Jordan 1 Retro High OG Chicago 2015',  category:'collectibles', price:9.50,   end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m15', title:'Jordan Brand Lot — 12 Cards PSA Graded Mix',    category:'collectibles', price:7.75,   end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m16', title:'Pokémon 1st Edition Base Set Charizard PSA 6',  category:'collectibles', price:55.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m17', title:'Vintage Lego Star Wars Millennium Falcon 10179', category:'collectibles', price:28.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  // Fashion
  { id:'m18', title:'Versace Black Medusa Small T-Shirt Men S',      category:'fashion',      price:11.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m19', title:'Versace Jeans Couture Logo Hoodie Black XL',    category:'fashion',      price:16.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m20', title:'Nike Air Jordan 1 Mid Black White Gym Red Sz 10',category:'fashion',     price:8.25,   end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m21', title:'Off-White x Nike Dunk Low Lot 34/50 DS Sz 9',  category:'fashion',      price:44.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m22', title:'Supreme Box Logo Hoodie FW22 Black Large',      category:'fashion',      price:21.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  // Sports / Misc
  { id:'m23', title:'Callaway Paradym X Driver 9° Stiff HZRDUS',    category:'sports',       price:17.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m24', title:'Peloton Bike+ Smart Exercise Bike With Screen',  category:'sports',       price:88.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m25', title:'DJI Mini 4 Pro Drone Fly More Combo RC2',       category:'electronics',  price:62.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m26', title:'Apple Watch Ultra 2 49mm Titanium Alpine Band', category:'watches',      price:33.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m27', title:'KitchenAid 7qt Pro Line Stand Mixer Onyx Black',category:'electronics',  price:24.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m28', title:'Dyson V15 Detect Absolute Cordless Vacuum',     category:'electronics',  price:19.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m29', title:'Herman Miller Aeron Chair Size B Remastered',    category:'sports',       price:72.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m30', title:'Nintendo Switch OLED White + Mario Kart 8',      category:'electronics',  price:13.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m31', title:'Apple Mac Mini M2 Pro 16GB 512GB Silver',         category:'electronics',  price:182.00, end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m32', title:'Apple AirPods Pro 2nd Gen USB-C MagSafe Case',    category:'electronics',  price:28.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m33', title:'Rolex GMT-Master II 126710BLRO Pepsi Oyster',     category:'watches',      price:44.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m34', title:'Omega Speedmaster Professional Moonwatch 42mm',   category:'watches',      price:37.25,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m35', title:'Nike x Off-White Sneaker Collection DS Lot of 3', category:'fashion',      price:52.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m36', title:'Supreme FW23 Box Logo Crewneck Navy Medium',      category:'fashion',      price:19.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m37', title:'Versace Pour Homme EDT 3.4oz + Travel Spray Set', category:'fashion',      price:14.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m38', title:'Sony PlayStation 5 Slim Disc Edition White',      category:'electronics',  price:66.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m39', title:'Nike Air Max 90 "Infrared" 2023 Retro Sz 11',    category:'fashion',      price:11.75,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m40', title:'Dyson Airwrap Complete Long Styler Nickel/Copper', category:'electronics', price:42.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m41', title:'Jordan Retro 3 "Fire Red" 2022 DS Sz 10.5',      category:'fashion',      price:16.00,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
  { id:'m42', title:'Bose 700 Noise Cancelling Headphones Silver',     category:'electronics',  price:26.50,  end:0, url:'https://www.nellisauction.com', img:'', premium:0 },
];

function getMockItems(keyword, maxPrice) {
  const now = Date.now();
  const kws = keyword.toLowerCase().split(/\s+/);

  // Assign staggered end times in the 5 PM – 10 PM window (today)
  const today5pm = new Date(); today5pm.setHours(17,0,0,0);
  const today10pm = new Date(); today10pm.setHours(22,0,0,0);
  const windowMs = today10pm - today5pm; // 5 hours

  return MOCK_POOL
    .filter(item => {
      const t = item.title.toLowerCase();
      return kws.some(k => t.includes(k));
    })
    .filter(item => item.price <= maxPrice)
    .map((item, i) => {
      // Spread end times evenly across the 5–10 PM auction window
      const fraction = (i + Math.random() * 0.3) / MOCK_POOL.length;
      const endTime = today5pm.getTime() + fraction * windowMs;
      return { ...item, end: Math.max(endTime, now + 60_000) };
    });
}

const MOCK_MODE = process.env.MOCK_MODE === 'true';

// ── Scanner ──────────────────────────────────────────────────
let scanInProgress = false;

async function runScan(targetKeyword = null) {
  if (scanInProgress) { console.log('[scan] already running — skipped'); return; }
  scanInProgress = true;

  const targets = targetKeyword
    ? watchlist.filter(w => (w.kws||[w.kw]).join(' ') === targetKeyword)
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
      const kws  = w.kws || (w.kw ? [w.kw] : []);
      const query = kws.join(' ');
      const label = kws.join(', ');

      const raw = MOCK_MODE
        ? getMockItems(query, w.th)
        : await searchNellis(query, w.th);

      // Filter by keyword match logic before adding to results
      const matched = raw.filter(item => matchesKeywords(item.title, w));

      matched.forEach(item => {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          fresh.push({ ...item, wid: w.id, th: w.th, tw: w.tw, keyword: label });
        }
      });

      console.log(`[scan] "${label}": ${raw.length} raw → ${matched.length} matched (${w.mode||'all'} keywords)`);
      broadcast({ type: 'keyword_done', keyword: label, count: matched.length });
    } catch (err) {
      const label = (w.kws||[w.kw]).join(', ');
      console.error(`[scan] "${label}" failed:`, err.message);
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

    const snipeMs = (item.tw || 10) * 60_000;
    if (rem <= snipeMs) {
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
    const w = watchlist.find(x => (x.kws || (x.kw ? [x.kw] : [])).join(', ') === kw);
    if (!w) continue;
    if (keywords.indexOf(kw) > 0) await new Promise(r => setTimeout(r, 6000 + Math.random() * 8000));
    try {
      const query = (w.kws || (w.kw ? [w.kw] : [])).join(' ');
      const fresh = await searchNellis(query, w.th);
      // Merge: update matching items in liveItems
      fresh.forEach(fi => {
        const idx = liveItems.findIndex(i => i.id === fi.id);
        if (idx !== -1) liveItems[idx] = { ...liveItems[idx], price: fi.price, end: fi.end };
        else liveItems.push({ ...fi, wid: w.id, th: w.th, tw: w.tw, keyword: (w.kws || (w.kw ? [w.kw] : [])).join(', ') });
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
    const scanKey = (item.kws || (item.kw ? [item.kw] : [])).join(' ');
    if (scanKey) setTimeout(() => runScan(scanKey), 500);
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
    const ctxWatches = watchlist.map(w => ({ keyword: (w.kws || (w.kw ? [w.kw] : [])).join(', '), maxPrice: `$${w.th.toFixed(2)}`, category: w.cat }));
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
  console.log(`   Daily scan  : ${SCAN_CRON}  (±5 min jitter — default 4:00 PM)`);
  console.log(`   Alert gate  : price ≤ threshold AND ≤ 10 min remaining → alert; price > threshold → discard`);
  console.log(`   Price refresh: every 5 min for items ending within 90 min\n`);

  // In mock mode, seed demo watches and auto-scan so the UI has data immediately
  if (MOCK_MODE) {
    if (!watchlist.length) {
      watchlist = [
        { id: 1, kws: ['macbook', 'apple', 'laptop'], mode: 'some', minMatch: 1, th: 999, tw: 10, cat: 'electronics' },
        { id: 2, kws: ['rolex', 'omega', 'watch'],    mode: 'some', minMatch: 1, th: 999, tw: 10, cat: 'watches'     },
        { id: 3, kws: ['jordan', 'nike', 'sneaker'],  mode: 'some', minMatch: 1, th: 999, tw: 10, cat: 'collectibles'},
        { id: 4, kws: ['bose', 'sony', 'dyson'],      mode: 'some', minMatch: 1, th: 999, tw: 10, cat: 'electronics' },
        { id: 5, kws: ['versace', 'supreme', 'off-white'], mode: 'some', minMatch: 1, th: 999, tw: 15, cat: 'fashion'},
      ];
      saveWatchlist();
      console.log('[mock] seeded 5 demo watches');
    }
    setTimeout(runScan, 800);
  }
});
