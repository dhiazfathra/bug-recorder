const test = require('node:test');
const assert = require('node:assert');

function loadBackground() {
  const listeners = { onRemoved: null, onMessage: null };
  const closeDocumentCalls = [];

  global.navigator = { userAgent: 'test-agent' };
  global.chrome = {
    webRequest: {
      onBeforeRequest: { addListener: () => {} },
      onCompleted: { addListener: () => {} },
      onErrorOccurred: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      sendMessage: () => Promise.resolve(),
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      query: () => Promise.resolve([{ id: 7, url: 'https://example.com' }]),
    },
    tabCapture: { getMediaStreamId: () => Promise.resolve('stream-1') },
    offscreen: {
      createDocument: () => Promise.resolve(),
      closeDocument: () => { closeDocumentCalls.push(1); return Promise.resolve(); },
    },
  };

  delete require.cache[require.resolve('../extension/background.js')];
  require('../extension/background.js');

  const getStatus = () => new Promise((resolve) => {
    listeners.onMessage({ type: 'status' }, {}, resolve);
  });

  return { listeners, getStatus, closeDocumentCalls };
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
