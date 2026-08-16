// Measures what the extension costs while IDLE (not recording): the two shapes
// that made Chrome feel laggy at startup. See ADR-0005.
//   npm run e2e:setup   (once, for the pinned browser)
//   npm run bench
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from '../test/chrome-path.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../extension');
const exe = chromePath();

const LOGS = 300, REQS = 40, TABS = 12;

// Times its own console loop, so we measure main-thread cost inside the page.
const PAGE = `<!doctype html><title>t</title><body><script>
  const t0 = performance.now();
  for (let i = 0; i < ${LOGS}; i++) console.log('entry', i, { i });
  window.__consoleMs = performance.now() - t0;
  const p = [];
  for (let i = 0; i < ${REQS}; i++) p.push(fetch('/r/' + i));
  Promise.all(p).then(() => { document.title = 'done'; });
</script>`;

const serve = async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/r/')) { res.writeHead(200); return res.end('x'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, r));
  return { server, origin: `http://localhost:${server.address().port}` };
};

async function run(withExt) {
  const { server, origin } = await serve();
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (withExt) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch');

  const browser = await puppeteer.launch({ executablePath: exe, headless: false, args });
  if (withExt) await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });

  // All at once, the way a session restore opens the previous window's tabs.
  const t0 = Date.now();
  const pages = await Promise.all(Array.from({ length: TABS }, async (_, i) => {
    const page = await browser.newPage();
    await page.goto(`${origin}/p${i}`, { waitUntil: 'networkidle2' });
    return page;
  }));
  const restoreMs = Date.now() - t0;

  const consoleMs = await Promise.all(pages.map((p) => p.evaluate(() => window.__consoleMs)));

  await browser.close();
  server.close();
  return { restoreMs, consoleMs: consoleMs.reduce((a, b) => a + b, 0) / consoleMs.length };
}

const off = [], on = [];
for (let i = 0; i < 3; i++) { off.push(await run(false)); on.push(await run(true)); }
const med = (xs, k) => xs.map((x) => x[k]).sort((a, b) => a - b)[1];

const ro = med(off, 'restoreMs'), rw = med(on, 'restoreMs');
const co = med(off, 'consoleMs'), cw = med(on, 'consoleMs');
console.log(`${TABS} tabs opened at once : without ${ro}ms | with ${rw}ms | ${(rw / ro * 100 - 100).toFixed(0)}%`);
console.log(`${LOGS} console.log in page : without ${co.toFixed(1)}ms | with ${cw.toFixed(1)}ms | ${(cw / co * 100 - 100).toFixed(0)}%`);
console.log(`per console.log          : without ${(co / LOGS * 1000).toFixed(0)}us | with ${(cw / LOGS * 1000).toFixed(0)}us`);
