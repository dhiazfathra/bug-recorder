// Produces the screenshots and screen recording attached to the PR.
//
// No entry in the report is written by hand. The popup is the extension's own
// page as Chrome renders it; the console entries travel the extension's real
// inject.js -> relay.js -> service worker path; the network entries are read
// from chrome.webRequest with the same per-tab filter background.js uses,
// wired here because the extension only attaches those listeners inside a
// recording session and starting one needs a genuine toolbar click.
//
// Requires ffmpeg on PATH (to turn the screencast into a GIF).
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

// Everything runs inside try/finally: a failure anywhere below would otherwise
// leave a headful Chrome and an open server holding the event loop open, and
// the script would hang instead of reporting what went wrong.
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    args: [...launchArgs(EXT), '--window-size=1200,860'],
  });

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

  // --- 2. collect real entries, the way a recording session does ---
  // Console goes through the extension's own inject.js -> relay.js -> worker
  // path. Network is collected here with chrome.webRequest and the same
  // per-tab filter background.js uses, because the extension only attaches
  // those listeners inside a session and starting one needs a toolbar click.
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto(origin, { waitUntil: 'networkidle2' });
  const tabId = await swEval(sw, '(async () => (await chrome.tabs.query({ active: true }))[0].id)()');

  await swEval(sw, `self.__seen = [];
    self.__net = [];
    self.__pending = new Map();
    chrome.runtime.onMessage.addListener((m) => { if (m.type === 'log') self.__seen.push(m.entry); });
    chrome.webRequest.onBeforeRequest.addListener(
      (d) => self.__pending.set(d.requestId, d.timeStamp), { urls: ['<all_urls>'], tabId: ${tabId} });
    chrome.webRequest.onCompleted.addListener((d) => {
      const started = self.__pending.get(d.requestId);
      if (started === undefined) return;
      self.__pending.delete(d.requestId);
      self.__net.push({ kind: 'network', t: started, method: d.method, url: d.url,
        resourceType: d.type, status: d.statusCode, durationMs: Math.round(d.timeStamp - started) });
    }, { urls: ['<all_urls>'], tabId: ${tabId} });
    true`);

  // switch console capture on the way start() does
  await swEval(sw, `(async () => {
    for (const t of await chrome.tabs.query({})) {
      await chrome.tabs.sendMessage(t.id, { type: 'capture', on: true }).catch(() => {});
    }
    return true;
  })()`);

  const t0 = Date.now();
  await page.click('#apply');
  await new Promise((r) => setTimeout(r, 900));
  const logs = await swEval(sw, 'self.__seen');
  const net = await swEval(sw, 'self.__net');
  await page.close();

  if (!logs.length) throw new Error('no console entries collected — the content scripts are not delivering');
  if (!net.length) throw new Error('no network entries collected — the webRequest filter caught nothing');

  // --- 3. the report, built from those real entries ---
  const entries = [...logs, ...net]
    .map((e) => ({ ...e, at: Math.max(0, e.t - t0) }))
    .sort((a, b) => a.at - b.at);

  const report = buildReport({
    description: 'Bug on Checkout — Acme Store',
    url: `${origin}/checkout`,
    startedAt: t0,
    durationMs: Date.now() - t0,
    userAgent: await browser.userAgent(),
    video: '', // the capture path cannot be driven headlessly; see PR notes
    entries,
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

  console.log(`collected ${logs.length} console and ${net.length} network entries`);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}

// GitHub embeds animated GIFs inline in a PR body; .webm only renders as a link.
execFileSync('ffmpeg', ['-y', '-i', path.join(OUT, 'report-demo.webm'),
  '-vf', 'fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
  '-loop', '0', path.join(OUT, 'report-demo.gif')], { stdio: 'ignore' });
fs.unlinkSync(path.join(OUT, 'report-demo.webm'));

const size = (f) => `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`;
for (const f of fs.readdirSync(OUT)) console.log(`${f}  ${size(f)}`);
