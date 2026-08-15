const test = require('node:test');
const assert = require('node:assert');

function loadBackground(overrides = {}) {
  const listeners = { onRemoved: null, onMessage: null, onBeforeRequest: null, onCompleted: null };
  const closeDocumentCalls = [];
  const sent = [];
  let calls = 0;

  // navigator is a read-only global in Node, so a plain assignment is a no-op.
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-agent' }, configurable: true });
  global.chrome = {
    webRequest: {
      onBeforeRequest: { addListener: (fn) => { listeners.onBeforeRequest = fn; } },
      onCompleted: { addListener: (fn) => { listeners.onCompleted = fn; } },
      onErrorOccurred: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendMessage: (msg) => {
        sent.push(msg);
        // Real Chrome delivers a sendMessage broadcast back to the sender's own
        // onMessage listener too, so simulate that self-delivery here. The loop it
        // used to cause is asynchronous (each nested start/stop yields at its first
        // await), so cap total calls rather than nesting depth — otherwise a
        // reintroduced loop hangs the run instead of failing it.
        if (++calls > 50) throw new Error('message loop: background reprocessed its own broadcast');
        listeners.onMessage(msg, {}, () => {});
        return Promise.resolve(overrides.startResponse);
      },
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      query: () => Promise.resolve([{ id: 7, url: 'https://example.com' }]),
    },
    tabCapture: { getMediaStreamId: () => Promise.resolve('stream-1') },
    offscreen: {
      createDocument: overrides.createDocument ?? (() => Promise.resolve()),
      closeDocument: () => { closeDocumentCalls.push(1); return Promise.resolve(); },
    },
  };

  delete require.cache[require.resolve('../extension/background.js')];
  require('../extension/background.js');

  const getStatus = () => new Promise((resolve) => {
    listeners.onMessage({ type: 'status' }, {}, resolve);
  });

  const start = (opts = {}) => new Promise((resolve) => {
    listeners.onMessage({ type: 'start', description: 'bug', ...opts }, {}, resolve);
  });

  return { listeners, getStatus, closeDocumentCalls, sent, start };
}

test('tab closed mid-recording clears session so next start is not blocked', async () => {
  const { listeners, getStatus, closeDocumentCalls } = loadBackground();

  await new Promise((resolve) => {
    listeners.onMessage({ type: 'start', description: 'bug' }, {}, resolve);
  });
  assert.strictEqual((await getStatus()).recording, true, 'recording after start');

  listeners.onRemoved(7);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual((await getStatus()).recording, false, 'session cleared after tab removal');
  assert.strictEqual(closeDocumentCalls.length, 1, 'offscreen document closed');
});

const stopEntries = async ({ listeners, sent }) => {
  await new Promise((resolve) => listeners.onMessage({ type: 'stop' }, {}, resolve));
  return sent.find((m) => m.type === 'stop').report.entries;
};

test('completions for untracked request ids are dropped', async () => {
  const bg = await (async () => { const b = loadBackground(); await b.start(); return b; })();

  bg.listeners.onBeforeRequest({ tabId: 7, requestId: 'a', timeStamp: 1000 });
  bg.listeners.onCompleted({ tabId: 7, requestId: 'a', timeStamp: 1200, method: 'GET', url: 'u', type: 'xhr', statusCode: 200 });
  // never seen by onBeforeRequest (e.g. in flight before recording started)
  bg.listeners.onCompleted({ tabId: 7, requestId: 'ghost', timeStamp: 1300, method: 'GET', url: 'g', type: 'xhr', statusCode: 200 });
  // duplicate completion for an id already consumed
  bg.listeners.onCompleted({ tabId: 7, requestId: 'a', timeStamp: 1400, method: 'GET', url: 'u', type: 'xhr', statusCode: 200 });

  const entries = await stopEntries(bg);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].durationMs, 200);
});

test('pending map is capped so stalled requests cannot grow without bound', async () => {
  const bg = loadBackground();
  await bg.start();

  for (let i = 0; i < 5100; i++) bg.listeners.onBeforeRequest({ tabId: 7, requestId: `r${i}`, timeStamp: 1000 });
  // beyond the cap nothing is tracked, so its completion is dropped too
  bg.listeners.onCompleted({ tabId: 7, requestId: 'r5099', timeStamp: 1200, method: 'GET', url: 'u', type: 'xhr', statusCode: 200 });

  assert.deepStrictEqual(await stopEntries(bg), []);
});

test('failed offscreen start clears session and closes the document', async () => {
  const bg = loadBackground({ startResponse: { error: 'NotAllowedError' } });
  const res = await bg.start();

  assert.match(res.error, /NotAllowedError/);
  assert.strictEqual((await bg.getStatus()).recording, false);
  assert.strictEqual(bg.closeDocumentCalls.length, 1);
});

test('failed createDocument clears session', async () => {
  const bg = loadBackground({ createDocument: () => Promise.reject(new Error('boom')) });
  const res = await bg.start();

  assert.match(res.error, /boom/);
  assert.strictEqual((await bg.getStatus()).recording, false);
});

// chrome.runtime.sendMessage delivers to the sender's OWN onMessage listener as
// well as to other contexts. Without a target guard the worker reprocessed the
// {target:'offscreen'} message it had just sent as a fresh command, recursing
// until the popup's click never got a response — pressing Stop did nothing and
// no report was ever downloaded.

test('stop reaches the offscreen document exactly once', async () => {
  const bg = loadBackground();
  await bg.start();
  bg.sent.length = 0;

  await new Promise((resolve) => bg.listeners.onMessage({ type: 'stop' }, {}, resolve));

  const stops = bg.sent.filter((m) => m.target === 'offscreen' && m.type === 'stop');
  assert.strictEqual(stops.length, 1, 'one stop, no self-triggered repeats');
});

test('start reaches the offscreen document exactly once', async () => {
  const bg = loadBackground();

  const res = await bg.start();

  assert.deepStrictEqual(res, { ok: true });
  const starts = bg.sent.filter((m) => m.target === 'offscreen' && m.type === 'start');
  assert.strictEqual(starts.length, 1, 'one start, no self-triggered repeats');
});

test('offscreen-targeted messages are ignored by the service worker', async () => {
  const bg = loadBackground();
  await bg.start();

  // A stop addressed to the offscreen document must not be mistaken for the
  // popup's stop command, even though both carry type:'stop'.
  const handled = bg.listeners.onMessage({ target: 'offscreen', type: 'stop', report: {} }, {}, () => {});

  assert.strictEqual(handled, undefined, 'no response claimed for a message meant for offscreen');
  assert.strictEqual((await bg.getStatus()).recording, true, 'session untouched');
});

test('onRemoved for an unrelated tab does not touch an active session', async () => {
  const { listeners, getStatus } = loadBackground();

  await new Promise((resolve) => {
    listeners.onMessage({ type: 'start', description: 'bug' }, {}, resolve);
  });

  listeners.onRemoved(999);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual((await getStatus()).recording, true, 'unrelated tab removal leaves session intact');
});
