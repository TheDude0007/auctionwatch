require('dotenv').config();
const nodemailer = require('nodemailer');
const twilio     = require('twilio');
const fs         = require('fs');
const path       = require('path');

const NOTIF_FILE = path.join(__dirname, 'notifications.json');

function loadConfig() {
  try { return fs.existsSync(NOTIF_FILE) ? JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')) : {}; }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(cfg, null, 2));
}

function getMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = parseInt(SMTP_PORT || '587');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function getTwilio() {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return null;
  return { client: twilio(TWILIO_SID, TWILIO_TOKEN), from: TWILIO_FROM };
}

async function sendAlert(item) {
  const cfg = loadConfig();
  if (!cfg.email && !cfg.phone) return;

  const rem  = Math.max(0, item.end - Date.now());
  const secs = Math.floor(rem / 1000);
  const title = item.title.slice(0, 60);
  const price = `$${item.price.toFixed(2)}`;
  const max   = `$${(item.th || 0).toFixed(2)}`;

  if (cfg.email) {
    const mailer = getMailer();
    if (mailer) {
      const subject = `⚡ AuctionWatch — ${secs}s left — ${title}`;
      const html = `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#6c63ff;margin-bottom:4px">⚡ AuctionWatch Alert</h2>
          <p style="font-size:1.1rem;font-weight:bold;margin:8px 0">${item.title}</p>
          <table style="border-collapse:collapse;width:100%;margin:12px 0">
            <tr><td style="padding:6px 0;color:#888">Current bid</td><td style="font-weight:bold;color:#f72585">${price}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Your max</td><td>${max}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Time left</td><td style="font-weight:bold;color:#ff3c3c">${secs} seconds</td></tr>
          </table>
          <a href="${item.url}" style="display:inline-block;background:#6c63ff;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Bid Now ↗</a>
        </div>`;
      const text = `AuctionWatch Alert\n"${item.title}"\nCurrent bid: ${price} (max ${max})\nTime left: ${secs}s\nBid: ${item.url}`;
      try {
        await mailer.sendMail({ from: process.env.SMTP_USER, to: cfg.email, subject, text, html });
        console.log(`[notifier] email → ${cfg.email}`);
      } catch (e) { console.error('[notifier] email failed:', e.message); }
    }
  }

  if (cfg.phone) {
    const tw = getTwilio();
    if (tw) {
      const body = `⚡ AuctionWatch: "${title}" — ${price} — ${secs}s left! ${item.url}`;
      try {
        await tw.client.messages.create({ body, from: tw.from, to: cfg.phone });
        console.log(`[notifier] SMS → ${cfg.phone}`);
      } catch (e) { console.error('[notifier] SMS failed:', e.message); }
    }
  }
}

module.exports = { sendAlert, loadConfig, saveConfig };
