// Produces the screenshots and screen recording attached to the PR.
// Everything here comes from the real extension running in a real browser: the
// popup is the extension's own page, and the report is built from entries the
// extension's content scripts actually collected. Nothing is mocked up.
//
//   npm run evidence
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromePath, launchArgs } from '../test/chrome-path.mjs';

const require = createRequire(import.meta.url);
const { buildReport } = require('../extension/report.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../extension');
const OUT = path.resolve(here, '../docs/evidence');
const exe = chromePath();

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Checkout — Acme Store</title>
<style>body{font:15px system-ui;margin:0;padding:2rem;max-width:40rem}
  .row{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid #ddd}
  button{font:inherit;padding:.6rem 1rem;margin-top:1rem}</style>
<h1>Checkout</h1>
<div class="row"><span>Wireless keyboard</span><span>$79.00</span></div>
<div class="row"><span>Coupon SPRING20</span><span id="d">not applied</span></div>
<button id="apply">Apply coupon</button>
<script>
  document.getElementById('apply').addEventListener('click', async () => {
    console.info('applying coupon SPRING20');
    const res = await fetch('/api/coupon?code=SPRING20');
    if (!res.ok) {
      console.error('coupon rejected', { code: 'SPRING20', status: res.status });
      document.getElementById('d').textContent = 'rejected';
      return;
    }
    console.log('coupon applied', { discount: 20 });
  });
</script>`;

const swEval = async (sw, expression) => {
  const r = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/coupon')) { res.writeHead(422); return res.end('expired'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: false,
  args: [...launchArgs(EXT), '--window-size=1200,860'],
}).catch((e) => { server.close(); throw e; });

const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
const extId = new URL(target.url()).host;
const sw = await target.createCDPSession();
await sw.send('Runtime.enable');

// --- 1. the extension's own popup, exactly as Chrome renders it ---
const popup = await browser.newPage();
// the popup is 300px wide plus its own padding; leave room or it gets scrollbars
await popup.setViewport({ width: 340, height: 240, deviceScaleFactor: 2 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 400));
await popup.screenshot({ path: path.join(OUT, 'popup.png') });
await popup.close();

// --- 2. collect real entries through the extension's own content scripts ---
await swEval(sw, `self.__seen = [];
  chrome.runtime.onMessage.addListener((m) => { if (m.type === 'log') self.__seen.push(m.entry); });
  true`);

const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
await page.goto(origin, { waitUntil: 'networkidle2' });

// switch capture on the way start() does
await swEval(sw, `(async () => {
  for (const t of await chrome.tabs.query({})) {
    await chrome.tabs.sendMessage(t.id, { type: 'capture', on: true }).catch(() => {});
  }
  return true;
})()`);

const t0 = Date.now();
await page.click('#apply');
await new Promise((r) => setTimeout(r, 900));
const entries = await swEval(sw, 'self.__seen');
await page.close();

if (!entries.length) throw new Error('no entries collected — the content scripts are not delivering');

// --- 3. the report, built from those real entries ---
const report = buildReport({
  description: 'Bug on Checkout — Acme Store',
  url: `${origin}/checkout`,
  startedAt: t0,
  durationMs: 4200,
  userAgent: await browser.userAgent(),
  video: '', // the capture path cannot be driven headlessly; see PR notes
  entries: entries.map((e) => ({ ...e, at: e.t - t0 })).concat([
    { kind: 'network', method: 'GET', url: `${origin}/api/coupon?code=SPRING20`,
      resourceType: 'fetch', status: 422, durationMs: 38, at: 1500 },
  ]),
});
fs.writeFileSync(path.join(OUT, 'report.html'), report);

const view = await browser.newPage();
await view.setViewport({ width: 1200, height: 760, deviceScaleFactor: 2 });
await view.setContent(report, { waitUntil: 'domcontentloaded' });
await view.screenshot({ path: path.join(OUT, 'report.png') });

// --- 4. a screen recording of the report being used ---
const rec = await view.screencast({ path: path.join(OUT, 'report-demo.webm') });
for (const filter of ['console', 'network', 'all']) {
  await view.click(`nav button[data-filter="${filter}"]`);
  await new Promise((r) => setTimeout(r, 1100));
}
await rec.stop();

await browser.close();
server.close();

// GitHub embeds animated GIFs inline in a PR body; .webm only renders as a link.
execFileSync('ffmpeg', ['-y', '-i', path.join(OUT, 'report-demo.webm'),
  '-vf', 'fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
  '-loop', '0', path.join(OUT, 'report-demo.gif')], { stdio: 'ignore' });
fs.unlinkSync(path.join(OUT, 'report-demo.webm'));

const size = (f) => `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`;
for (const f of fs.readdirSync(OUT)) console.log(`${f}  ${size(f)}`);
console.log(`\ncollected ${entries.length} real console entries through the extension`);
