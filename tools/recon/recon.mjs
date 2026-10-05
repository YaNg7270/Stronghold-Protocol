// Recon script: open the online game in Chromium, play/idle for a while,
// and dump everything needed to plan an offline port.
//
// Usage:
//   npm i -D playwright && npx playwright install chromium
//   node tools/recon/recon.mjs [url] [seconds]
//
// Output (recon-output/):
//   site/            every HTTP response body, mirrored by URL path
//   requests.jsonl   method, url, status, content-type, request body for each request
//   websocket.jsonl  every WebSocket frame (sent/received)
//   storage.json     cookies, localStorage, sessionStorage at the end
//   console.log      browser console output
//   network.har      full HAR (headers + bodies)
//   screenshot-*.png start / end screenshots
//
// The browser window is visible: play the game normally during the capture
// (log in, start a match, open menus) so the dump covers those code paths.
// Set HEADLESS=1 to run without a window.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://103.205.253.194:27527/';
const seconds = Number(process.argv[3] || 180);
const out = path.resolve('recon-output');
const siteDir = path.join(out, 'site');
fs.mkdirSync(siteDir, { recursive: true });

const requestsLog = fs.createWriteStream(path.join(out, 'requests.jsonl'));
const wsLog = fs.createWriteStream(path.join(out, 'websocket.jsonl'));
const consoleLog = fs.createWriteStream(path.join(out, 'console.log'));

function localPathFor(u) {
  const parsed = new URL(u);
  let p = decodeURIComponent(parsed.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const host = parsed.host.replace(/[:]/g, '_');
  // Keep query strings distinguishable without producing invalid file names.
  const q = parsed.search ? '__' + parsed.search.slice(1).replace(/[^\w.-]/g, '_').slice(0, 80) : '';
  return path.join(siteDir, host, p + q);
}

const browser = await chromium.launch({ headless: process.env.HEADLESS === '1' });
const context = await browser.newContext({
  recordHar: { path: path.join(out, 'network.har'), content: 'embed' },
});
const page = await context.newPage();

page.on('console', (msg) => consoleLog.write(`[${msg.type()}] ${msg.text()}\n`));
page.on('pageerror', (err) => consoleLog.write(`[pageerror] ${err.message}\n`));

page.on('response', async (res) => {
  const req = res.request();
  const entry = {
    t: Date.now(),
    method: req.method(),
    url: res.url(),
    status: res.status(),
    type: res.headers()['content-type'] || '',
    resourceType: req.resourceType(),
    postData: req.postData() || undefined,
  };
  requestsLog.write(JSON.stringify(entry) + '\n');
  if (!res.url().startsWith('http')) return;
  try {
    const body = await res.body();
    const file = localPathFor(res.url());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  } catch {
    // Redirects and aborted requests have no body.
  }
});

page.on('websocket', (ws) => {
  const log = (dir) => (frame) =>
    wsLog.write(JSON.stringify({
      t: Date.now(),
      url: ws.url(),
      dir,
      payload: typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('base64'),
      binary: typeof frame.payload !== 'string',
    }) + '\n');
  wsLog.write(JSON.stringify({ t: Date.now(), url: ws.url(), dir: 'open' }) + '\n');
  ws.on('framesent', log('sent'));
  ws.on('framereceived', log('received'));
  ws.on('close', () => wsLog.write(JSON.stringify({ t: Date.now(), url: ws.url(), dir: 'close' }) + '\n'));
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.screenshot({ path: path.join(out, 'screenshot-start.png'), fullPage: true });
console.log(`Capturing for ${seconds}s - play the game in the opened window...`);
await page.waitForTimeout(seconds * 1000);

await page.screenshot({ path: path.join(out, 'screenshot-end.png'), fullPage: true });
const storage = await page.evaluate(() => ({
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
}));
storage.cookies = await context.cookies();
fs.writeFileSync(path.join(out, 'storage.json'), JSON.stringify(storage, null, 2));

await context.close(); // flushes the HAR
await browser.close();
for (const s of [requestsLog, wsLog, consoleLog]) s.end();
console.log(`Done. Output in ${out}`);
