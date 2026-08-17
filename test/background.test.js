const test = require('node:test');
const assert = require('node:assert');

function loadBackground(overrides = {}) {
  const listeners = { onRemoved: null, onMessage: null, onBeforeRequest: null, onCompleted: null };
  const closeDocumentCalls = [];
  const sent = [];
  const capture = []; // { tabId, on } pushed as content scripts are switched
  // webRequest listeners are attached only while recording, so track both the
  // filters they were attached with and whether they were detached again.
  const attached = { onBeforeRequest: null, onCompleted: null, onErrorOccurred: null };
  const filters = [];

  const web = (name) => ({
    addListener: (fn, filter) => {
      attached[name] = fn;
      listeners[name] = fn;
      if (filter) filters.push({ name, ...filter });
    },
    removeListener: () => { attached[name] = null; },
  });

  // navigator is a read-only global in Node, so a plain assignment is a no-op.
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-agent' }, configurable: true });
  global.chrome = {
    webRequest: {
      onBeforeRequest: web('onBeforeRequest'),
      onCompleted: web('onCompleted'),
      onErrorOccurred: web('onErrorOccurred'),
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendMessage: (msg) => {
        sent.push(msg);
        if (msg.type === 'stop' && overrides.stopRejects) return Promise.reject(new Error('offscreen gone'));
        return Promise.resolve(overrides.startResponse);
      },
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      query: () => Promise.resolve([{ id: 7, url: 'https://example.com', ...overrides.tab }]),
      sendMessage: (tabId, msg) => {
        if (msg.type === 'capture') capture.push({ tabId, on: msg.on });
        return Promise.resolve();
      },
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

  return { listeners, getStatus, closeDocumentCalls, sent, start, stopReport, capture, attached, filters };
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

test('the entry log is capped, keeping the earliest entries', async () => {
  const bg = loadBackground();
  await bg.start();

  for (let i = 0; i < 5100; i++) {
    bg.listeners.onMessage({ type: 'log', entry: { kind: 'console', level: 'log', text: `e${i}`, t: 1000 } },
      { tab: { id: 7 } }, () => {});
  }

  const entries = await stopEntries(bg);
  assert.strictEqual(entries.length, 5000, 'capped, so a noisy page cannot grow the buffer forever');
  // README documents this: the newest are dropped, the beginning is kept.
  assert.strictEqual(entries[0].text, 'e0');
  assert.strictEqual(entries.at(-1).text, 'e4999');
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

// An idle extension must cost the browser nothing: listeners left on <all_urls>
// wake this worker for every request in every tab. See ADR-0005.
test('an idle extension watches no network traffic at all', () => {
  const bg = loadBackground();

  assert.deepStrictEqual(
    Object.values(bg.attached).filter(Boolean), [],
    'nothing is attached until a recording starts');
});

test('recording attaches listeners scoped to the recorded tab only', async () => {
  const bg = loadBackground();
  await bg.start();

  assert.strictEqual(Object.values(bg.attached).filter(Boolean).length, 3);
  assert.deepStrictEqual([...new Set(bg.filters.map((f) => f.tabId))], [7],
    'filtered to the recorded tab, not <all_urls> browser-wide');
  assert.deepStrictEqual(bg.capture, [{ tabId: 7, on: true }],
    'the page is told to start serializing console calls');
});

test('stopping detaches every listener and silences the page', async () => {
  const bg = loadBackground();
  await bg.start();
  await bg.stopReport();
  // fire-and-forget: this branch never calls sendResponse
  bg.listeners.onMessage({ type: 'recording-ended' }, {}, () => {});

  assert.deepStrictEqual(Object.values(bg.attached).filter(Boolean), [],
    'listeners must not survive the recording');
  assert.deepStrictEqual(bg.capture.at(-1), { tabId: 7, on: false });
});

test('a failed start leaves nothing attached behind', async () => {
  const bg = loadBackground({ startResponse: { error: 'NotAllowedError' } });
  await bg.start();

  assert.deepStrictEqual(Object.values(bg.attached).filter(Boolean), [],
    'a failed start must not leak listeners onto every page');
  assert.deepStrictEqual(bg.capture.at(-1), { tabId: 7, on: false });
});

test('a tab closed mid-recording detaches its listeners', async () => {
  const bg = loadBackground();
  await bg.start();

  bg.listeners.onRemoved(7);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(Object.values(bg.attached).filter(Boolean), []);
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
  // parses fine, but has no hostname to name the report after
  for (const url of ['about:blank', 'data:text/html,<p>hi', 'file:///tmp/x.html']) {
    assert.strictEqual((await loadBackground({ tab: { title: '', url } }).start()).description,
      'Untitled bug', `${url} must not produce "Bug on "`);
  }
});

test('a failed stop releases the session instead of stranding the listeners', async () => {
  const bg = loadBackground({ stopRejects: true });
  await bg.start();

  await assert.rejects(() => new Promise((resolve, reject) => {
    bg.listeners.onMessage({ type: 'stop' }, {}, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
  }), /offscreen gone/);

  assert.strictEqual((await bg.getStatus()).recording, false);
  assert.deepStrictEqual(Object.values(bg.attached).filter(Boolean), [],
    'a failed stop must not leave listeners on every page');
  assert.deepStrictEqual(bg.capture.at(-1), { tabId: 7, on: false });
  assert.strictEqual(bg.closeDocumentCalls.length, 1,
    'a failed stop must close the offscreen document too');
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
