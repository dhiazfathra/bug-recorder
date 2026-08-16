// End-to-end checks against a real Chrome with the extension really installed.
//
// Covers what the unit tests cannot: that the manifest actually loads, that the
// MAIN-world console patch and the relay content script really deliver entries
// to the service worker on a real page, and that a generated report renders.
//
// NOT covered: the tabCapture -> offscreen -> MediaRecorder video path. Chrome
// only hands out a capture stream after the extension has been *invoked* on the
// tab (the activeTab grant), and that invocation must come from a genuine click
// on the toolbar icon. CDP cannot synthesize input into browser chrome, so no
// automated harness can grant it. See README "Testing status".
import { test } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildReport } = require('../extension/report.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../extension');

// The install dir also holds a .metadata entry, so pick the versioned one.
const chromePath = () => {
  const root = path.resolve(here, '../.chrome-for-testing/chrome');
  const version = fs.existsSync(root) && fs.readdirSync(root).find((d) => !d.startsWith('.'));
  if (!version) throw new Error('Chrome for Testing missing — run: npm run e2e:setup');
  const platform = fs.readdirSync(path.join(root, version))[0];
  const binary = platform.includes('mac')
    ? ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
    : [platform.includes('win') ? 'chrome.exe' : 'chrome'];
  return path.join(root, version, platform, ...binary);
};

const FIXTURE = `<!doctype html><title>Fixture</title><h1>fixture page</h1><script>
  console.log('plain log', { a: 1 });
  console.warn('a warning');
  console.error('an error');
  fetch('/api/thing').then(() => console.info('fetch settled'));
</script>`;

const WANT_LEVELS = ['log', 'warn', 'error', 'info'];

async function withBrowser(fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/thing') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, r));
  const origin = `http://localhost:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false, // extensions + tab capture need a real browser
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      // Chrome 137+ ignores --load-extension unless this feature is disabled.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run', '--no-default-browser-check',
    ],
  });
  try {
    return await fn({ browser, origin });
  } finally {
    await browser.close();
    server.close();
  }
}

const swEval = async (session, expression) => {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

test('the extension loads and its service worker starts', { timeout: 60000 }, async () => {
  await withBrowser(async ({ browser }) => {
    const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
    assert.match(target.url(), /background\.js$/, 'background service worker is running');

    const page = await browser.newPage();
    const res = await page.goto(`chrome-extension://${new URL(target.url()).host}/manifest.json`);
    const manifest = JSON.parse(await res.text());
    assert.strictEqual(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes('activeTab'),
      'activeTab is required for tabCapture: without it getMediaStreamId throws ' +
      '"Extension has not been invoked for the current page"');
  });
});

test('console output on a real page reaches the service worker', { timeout: 60000 }, async () => {
  await withBrowser(async ({ browser, origin }) => {
    const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
    const sw = await target.createCDPSession();
    await sw.send('Runtime.enable');

    // The worker only stores entries while recording, which needs a capture we
    // cannot start here, so observe the messages arriving instead.
    await swEval(sw, `self.__seen = [];
      chrome.runtime.onMessage.addListener((m) => { if (m.type === 'log') self.__seen.push(m.entry); });
      true`);

    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'networkidle2' });

    // The page is silent until a recording starts (ADR-0005), so nothing should
    // have arrived from its load-time console calls.
    assert.deepStrictEqual(await swEval(sw, 'self.__seen'), [],
      'an idle extension must not be fed console output');

    // Switch it on the way start() does, then make the calls we expect to see.
    await swEval(sw, `(async () => {
      for (const t of await chrome.tabs.query({})) {
        await chrome.tabs.sendMessage(t.id, { type: 'capture', on: true }).catch(() => {});
      }
      return true;
    })()`);
    await page.evaluate(() => {
      console.log('plain log', { a: 1 });
      console.warn('a warning');
      console.error('an error');
      console.info('fetch settled');
    });

    // Poll rather than sleep: content-script and worker delivery are not
    // synchronised with page load, so a fixed wait is flaky on slow machines.
    // On timeout fall through and let the assertions report what was missing.
    let seen = [];
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      seen = await swEval(sw, `self.__seen`);
      if (WANT_LEVELS.every((l) => seen.some((e) => e.level === l))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const levels = seen.map((e) => e.level);
    const texts = seen.map((e) => e.text).join('\n');

    assert.ok(seen.length >= 4, `expected the page's console calls, got ${seen.length}`);
    for (const level of WANT_LEVELS) {
      assert.ok(levels.includes(level), `missing ${level} entry; saw ${levels.join(',')}`);
    }
    assert.match(texts, /plain log/);
    assert.match(texts, /\{"a":1\}/, 'objects are serialized, not "[object Object]"');
    assert.ok(seen.every((e) => e.kind === 'console'), 'entries are tagged as console');
  });
});

test('a generated report renders its video and both log kinds', { timeout: 60000 }, async () => {
  await withBrowser(async ({ browser }) => {
    const html = buildReport({
      description: 'e2e report',
      url: 'http://localhost/fixture',
      startedAt: Date.now(),
      durationMs: 2000,
      userAgent: 'e2e',
      // 1x1 webm stand-in: this asserts the report embeds and exposes a player,
      // not that Chrome produced the bytes.
      video: 'data:video/webm;base64,GkXfo0AgQoaBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEXTbuMU6uEHFO7a1OsggG97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      entries: [
        { kind: 'console', level: 'error', text: 'boom happened', at: 120 },
        { kind: 'network', method: 'GET', url: 'http://localhost/api/thing', resourceType: 'fetch', status: 200, durationMs: 12, at: 340 },
      ],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    assert.ok(await page.$('video'), 'report contains a video player');
    const src = await page.$eval('video', (v) => v.currentSrc || v.src || v.querySelector('source')?.src || '');
    assert.match(src, /^data:video\/webm/, 'video is embedded, not linked to a missing file');

    const body = await page.evaluate(() => document.body.innerText);
    assert.match(body, /boom happened/, 'console entry rendered');
    assert.match(body, /api\/thing/, 'network entry rendered');
    assert.match(body, /e2e report/, 'description rendered');
  });
});

// The regression guard for ADR-0005. Deliberately counts events rather than
// milliseconds: wall-clock on a shared CI runner is too noisy to threshold, but
// "the idle worker was woken zero times" is exact and is the actual mechanism
// that made Chrome slow. bench/idle-cost.mjs measures the milliseconds.
test('an idle extension costs the browser nothing', { timeout: 60000 }, async () => {
  await withBrowser(async ({ browser, origin }) => {
    const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
    const sw = await target.createCDPSession();
    await sw.send('Runtime.enable');

    // Ask Chrome whether the extension is subscribed at all. Counting events
    // with our own <all_urls> listener would measure the probe, not the
    // extension: registering one guarantees the worker wakes for every request.
    const subscribed = () => swEval(sw, `[
      chrome.webRequest.onBeforeRequest.hasListeners(),
      chrome.webRequest.onCompleted.hasListeners(),
      chrome.webRequest.onErrorOccurred.hasListeners(),
    ]`);

    assert.deepStrictEqual(await subscribed(), [false, false, false],
      'an idle worker must not be subscribed to webRequest: on <all_urls> it is woken for ' +
      'every request the whole browser makes, which is most of what a session restore is');

    // Console messages cost nothing to observe, so count those directly.
    await swEval(sw, `self.__msgs = 0;
      chrome.runtime.onMessage.addListener((m) => { if (m.type === 'log') self.__msgs++; });
      true`);

    // Browse several pages that log and fetch, exactly as a session restore would.
    for (let i = 0; i < 4; i++) {
      const page = await browser.newPage();
      await page.goto(`${origin}/p${i}`, { waitUntil: 'networkidle2' });
      await page.close();
    }
    await new Promise((r) => setTimeout(r, 500)); // let any stragglers arrive

    assert.strictEqual(await swEval(sw, 'self.__msgs'), 0,
      'idle pages must not serialize and post their console calls to the worker');
    assert.deepStrictEqual(await subscribed(), [false, false, false],
      'still unsubscribed after browsing');
  });
});
