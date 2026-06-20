/**
 * NellisAuction stealth scraper
 *
 * Uses a real Chromium browser so the site sees a normal browser session.
 * The stealth plugin strips all automation fingerprints. Cookie + storage
 * persistence makes it look like a returning visitor. All timing is
 * randomised to human reading/interaction cadence.
 *
 * Selectors are derived from live DOM inspection of nellisauction.com.
 * Stable anchors used: data-ax attributes (semantic, unlikely to churn).
 */

const { chromium } = require('playwright-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const fs   = require('fs');
const path = require('path');

chromium.use(StealthPlugin());

// ── Constants ────────────────────────────────────────────────
const SITE         = 'https://www.nellisauction.com';
const COOKIES_FILE = path.join(__dirname, '.nellis-cookies.json');
const STORAGE_FILE = path.join(__dirname, '.nellis-storage.json');
const HEADLESS     = process.env.HEADLESS !== 'false';

// Realistic desktop UAs — rotated per session
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
];

const VIEWPORTS = [
  { width: 1440, height: 900  },
  { width: 1366, height: 768  },
  { width: 1920, height: 1080 },
  { width: 1536, height: 864  },
];

// ── Timing helpers ───────────────────────────────────────────
const rand    = (lo, hi) => lo + Math.random() * (hi - lo);
const pause   = (lo, hi) => new Promise(r => setTimeout(r, rand(lo, hi)));

/** Type each character with human-like variance in keystroke timing. */
async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: rand(38, 125) });
    if (Math.random() < 0.06) await pause(180, 650); // occasional micro-pause
  }
}

/** Move mouse to element via curved path, then click. */
async function humanClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) { await locator.click(); return; }

  const tx = box.x + box.width  * rand(0.3, 0.7);
  const ty = box.y + box.height * rand(0.3, 0.7);

  // Curve: approach from an offset point
  await page.mouse.move(tx + rand(-90, 90), ty + rand(-55, 55), { steps: Math.ceil(rand(8, 18)) });
  await pause(55, 180);
  await page.mouse.move(tx, ty, { steps: Math.ceil(rand(5, 12)) });
  await pause(35, 110);
  await page.mouse.click(tx, ty);
}

/** Scroll the page naturally as if a human is reading. */
async function humanScroll(page, distance) {
  const steps = Math.ceil(rand(5, 14));
  const step  = distance / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, step + rand(-25, 25));
    await pause(55, 175);
  }
}

// ── Browser singleton ────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// ── Session persistence ──────────────────────────────────────
function loadCookies() {
  try   { return fs.existsSync(COOKIES_FILE) ? JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')) : []; }
  catch { return []; }
}
function saveCookies(cookies) {
  try { fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2)); } catch { /* ok */ }
}

// ── Time string parser ───────────────────────────────────────
// Handles: "20 hours", "2 days", "3h 20m", "4m 50s", "45 minutes", "30 seconds"
function parseTimeLeft(text) {
  if (!text) return 0;
  const t = text.toLowerCase().trim();
  if (t.includes('ended') || t.includes('closed') || t.includes('sold')) return 0;

  const d  = parseFloat((t.match(/(\d+\.?\d*)\s*d(?:ay)?/) || [])[1] || 0);
  const h  = parseFloat((t.match(/(\d+\.?\d*)\s*h(?:our)?/) || [])[1] || 0);
  const m  = parseFloat((t.match(/(\d+\.?\d*)\s*m(?:in)?/) || [])[1] || 0);
  const s  = parseFloat((t.match(/(\d+\.?\d*)\s*s(?:ec)?/) || [])[1] || 0);

  return (d * 86400 + h * 3600 + m * 60 + s) * 1000;
}

// ── Item extraction (runs inside page.evaluate) ──────────────
function extractItems(args) {
  const { maxPrice, site } = args;

  const cards = [...document.querySelectorAll('[data-ax="item-card-container"]')];
  if (!cards.length) return { items: [], debug: 'no [data-ax="item-card-container"] found' };

  // Time parser (duplicated here since this runs in browser context)
  function parseTimeLeft(text) {
    if (!text) return 0;
    const t = text.toLowerCase().trim();
    if (t.includes('ended') || t.includes('closed') || t.includes('sold')) return 0;
    const d = parseFloat((t.match(/(\d+\.?\d*)\s*d(?:ay)?/)  || [])[1] || 0);
    const h = parseFloat((t.match(/(\d+\.?\d*)\s*h(?:our)?/) || [])[1] || 0);
    const m = parseFloat((t.match(/(\d+\.?\d*)\s*m(?:in)?/)  || [])[1] || 0);
    const s = parseFloat((t.match(/(\d+\.?\d*)\s*s(?:ec)?/)  || [])[1] || 0);
    return (d * 86400 + h * 3600 + m * 60 + s) * 1000;
  }

  const results = [];

  for (const card of cards) {
    try {
      // ── Title + URL ──
      const titleLink = card.querySelector('[data-ax="item-card-title-link"]');
      const title     = titleLink?.querySelector('h6')?.textContent?.trim();
      if (!title) continue;

      const href = titleLink?.getAttribute('href') || '';
      const url  = href.startsWith('http') ? href : `${site}${href}`;

      // ── Product ID from URL path (/p/slug/ID) ──
      const id = (url.match(/\/(\d+)\/?$/) || [])[1] || `nellis-${Math.random().toString(36).slice(2)}`;

      // ── Time remaining ──
      const timeContainer = card.querySelector('[data-ax="item-card-time-countdown-container"]');
      const timePs        = timeContainer ? [...timeContainer.querySelectorAll('p')] : [];
      // First <p> = "Time Left" label, second <p> = value ("20 hours")
      const timeText   = timePs[1]?.textContent?.trim() || timePs[0]?.textContent?.trim() || '';
      const timeLeftMs = parseTimeLeft(timeText);
      const endMs      = timeLeftMs > 0 ? Date.now() + timeLeftMs : 0;

      // ── Current bid price ──
      // The price box is the sibling div of the time countdown container.
      // Both live inside the same flex row. Find the <p> starting with "$".
      let price = 0;
      const allP = [...card.querySelectorAll('p')];
      const priceP = allP.find(p => /^\$[\d,]+/.test(p.textContent?.trim()));
      if (priceP) price = parseFloat(priceP.textContent.replace(/[^0-9.]/g, '')) || 0;

      // Skip items over threshold (but always include free/no-bid items with price 0)
      if (price > maxPrice && price > 0) continue;

      // ── Buyer's premium ──
      let premium = 0;
      const premiumLabel = allP.find(p => /buyer.{0,3}prem/i.test(p.textContent));
      if (premiumLabel) {
        const nextP = premiumLabel.closest('li')?.querySelector('p:last-child');
        premium = parseFloat((nextP?.textContent || '').replace(/[^0-9.]/g, '')) || 0;
      }

      // ── Image ──
      const img = card.querySelector('[data-ax="item-card-image-link"] img')?.getAttribute('src') || '';

      // ── Category (often empty; Nellis doesn't always populate it) ──
      const catEl   = card.querySelector('[class*="uppercase"][class*="text-gray"]');
      const category = catEl?.textContent?.trim() || 'General';

      results.push({ id, title, price, end: endMs, url, img, category, premium, timeText });
    } catch { /* malformed card — skip */ }
  }

  return {
    items: results,
    debug: `${cards.length} cards found → ${results.length} at or under $${maxPrice}`,
  };
}

// ── Main search function ─────────────────────────────────────
async function searchNellis(keyword, maxPrice) {
  const browser  = await getBrowser();
  const ua       = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

  const ctxOptions = {
    viewport,
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'DNT': '1',
    },
  };

  // Restore localStorage / IndexedDB state if we have it
  if (fs.existsSync(STORAGE_FILE)) {
    try { ctxOptions.storageState = STORAGE_FILE; } catch { /* ok */ }
  }

  const ctx  = await browser.newContext(ctxOptions);
  const cookies = loadCookies();
  if (cookies.length) await ctx.addCookies(cookies).catch(() => {});

  const page = await ctx.newPage();

  // Block media/fonts to reduce bandwidth — does not change JS fingerprint
  await page.route('**/*.{mp4,webm,ogg,mp3,wav,woff,woff2,ttf,eot}', r => r.abort());

  try {
    console.log(`[scraper] "${keyword}" — max $${maxPrice}`);

    // ── 1. Land on homepage (builds session cookies, looks human) ──
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await pause(1600, 3800);

    // Dismiss cookie/consent banner if present
    try {
      const consent = page.locator('button:has-text("Accept"), button:has-text("Got it"), button:has-text("Agree")').first();
      if (await consent.isVisible({ timeout: 2500 })) {
        await humanClick(page, consent);
        await pause(400, 900);
      }
    } catch { /* no banner */ }

    // Brief skim of homepage (human would glance at featured items)
    await humanScroll(page, rand(150, 350));
    await pause(900, 2200);

    // ── 2. Use the search input ──────────────────────────────────
    // Confirmed selector from live DOM: input[type="search"][name="query"]
    const searchInput = page.locator('input[type="search"][name="query"]').first();
    const searchVisible = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (searchVisible) {
      await humanClick(page, searchInput);
      await pause(250, 600);
      // Clear any existing text, then type keyword
      await page.keyboard.shortcut('Meta+a');
      await pause(80, 200);
      await humanType(page, keyword);
      await pause(350, 850);
      await page.keyboard.press('Enter');
    } else {
      // Fallback: navigate directly to search URL (still looks normal — many users do this)
      console.log('[scraper] search input not found — navigating to search URL directly');
      await page.goto(`${SITE}/search?q=${encodeURIComponent(keyword)}`, {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      });
    }

    // ── 3. Wait for results ──────────────────────────────────────
    // Wait for at least one item card to appear
    await page.waitForSelector('[data-ax="item-card-container"]', { timeout: 15_000 })
      .catch(() => console.log('[scraper] wait for cards timed out — proceeding anyway'));

    await pause(1500, 3200); // let all cards hydrate

    // Human behaviour: scroll down through results
    await humanScroll(page, rand(350, 700));
    await pause(800, 1800);
    await humanScroll(page, rand(200, 500));
    await pause(500, 1200);

    // ── 4. Extract ───────────────────────────────────────────────
    const { items, debug } = await page.evaluate(extractItems, { maxPrice, site: SITE });
    console.log(`[scraper] "${keyword}": ${debug}`);

    // ── 5. Persist session ───────────────────────────────────────
    saveCookies(await ctx.cookies());
    await ctx.storageState({ path: STORAGE_FILE }).catch(() => {});

    return items;

  } catch (err) {
    console.error(`[scraper] "${keyword}" error:`, err.message);
    return [];
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (_browser?.isConnected()) await _browser.close();
  _browser = null;
}

module.exports = { searchNellis, closeBrowser };
