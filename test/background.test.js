const test = require('node:test');
const assert = require('node:assert');

function loadBackground(overrides = {}) {
  const listeners = { onRemoved: null, onMessage: null, onBeforeRequest: null, onCompleted: null };
  const closeDocumentCalls = [];
  const sent = [];

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
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(overrides.startResponse); },
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      query: () => Promise.resolve([{ id: 7, url: 'https://example.com', ...overrides.tab }]),
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
    listeners.onMessage({ type: 'start', ...opts }, {}, resolve);
  });

  const stopReport = (description) => new Promise((resolve) => {
    listeners.onMessage({ type: 'stop', description }, {}, resolve);
  }).then(() => sent.find((m) => m.type === 'stop').report);

  return { listeners, getStatus, closeDocumentCalls, sent, start, stopReport };
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

test('the name is generated from the page title, no typing required', async () => {
  const bg = loadBackground({ tab: { title: '  Checkout — Acme  ' } });

  assert.strictEqual((await bg.start()).description, 'Bug on Checkout — Acme');
  assert.strictEqual((await bg.getStatus()).description, 'Bug on Checkout — Acme',
    'the popup can read the generated name back to prefill its field');
  assert.strictEqual((await bg.stopReport()).description, 'Bug on Checkout — Acme');
});

test('a titleless page falls back to its hostname, then to a placeholder', async () => {
  assert.strictEqual((await loadBackground().start()).description, 'Bug on example.com');
  assert.strictEqual(
    (await loadBackground({ tab: { title: '', url: 'not a url' } }).start()).description,
    'Untitled bug');
});

test('a name edited in the popup replaces the generated one', async () => {
  const bg = loadBackground({ tab: { title: 'Checkout' } });
  await bg.start();

  assert.strictEqual((await bg.stopReport('Coupon field rejects valid codes')).description,
    'Coupon field rejects valid codes');
});

test('a blank or whitespace edit keeps the generated name', async () => {
  const bg = loadBackground({ tab: { title: 'Checkout' } });
  await bg.start();

  assert.strictEqual((await bg.stopReport('   ')).description, 'Bug on Checkout',
    'clearing the field must not produce an unnamed report');
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
