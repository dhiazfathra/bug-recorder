// Smoke test for the capture path. MediaRecorder, getUserMedia, FileReader and
// URL.createObjectURL are faked, so this proves the control flow (cleanup on
// failure, recording-ended always firing) — not that Chrome actually records.
const test = require('node:test');
const assert = require('node:assert');

function loadOffscreen(overrides = {}) {
  let onMessage = null;
  const sent = [];
  const downloads = [];
  const stoppedTracks = [];
  const track = { stop: () => stoppedTracks.push(1) };
  const stream = { getTracks: () => [track] };

  class FakeMediaRecorder {
    constructor(s) {
      if (overrides.constructorThrows) throw new Error('MediaRecorder unsupported');
      this.stream = s;
    }
    start() {}
    stop() {
      setImmediate(() => this.onstop());
      setImmediate(() => this.ondataavailable({ data: { size: 4 } }));
    }
  }

  // navigator is a read-only global in Node, so a plain assignment is a no-op.
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } },
    configurable: true,
  });
  global.MediaRecorder = FakeMediaRecorder;
  global.buildReport = (data) => `<html>${data.video}</html>`;
  global.FileReader = class {
    readAsDataURL() {
      setImmediate(() => {
        this.result = 'data:video/webm;base64,ZmFrZQ==';
        this.onload();
      });
    }
  };
  globalThis.URL.createObjectURL = () => 'blob:fake';
  global.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
    },
    downloads: {
      download: (opts) => {
        downloads.push(opts);
        return overrides.downloadRejects ? Promise.reject(new Error('user cancelled')) : Promise.resolve(1);
      },
    },
  };

  delete require.cache[require.resolve('../extension/offscreen.js')];
  require('../extension/offscreen.js');

  const send = (msg) => new Promise((resolve) => onMessage({ target: 'offscreen', ...msg }, {}, resolve));
  const report = { description: 'bug', startedAt: 0, durationMs: 1000, entries: [] };

  return { send, sent, downloads, stoppedTracks, report, raw: (msg) => onMessage(msg, {}, () => {}) };
}

test('start then stop downloads a report and releases the session', async () => {
  const o = loadOffscreen();

  assert.deepStrictEqual(await o.send({ type: 'start', streamId: 's1' }), { ok: true });
  assert.deepStrictEqual(await o.send({ type: 'stop', report: o.report }), { ok: true });

  assert.strictEqual(o.downloads.length, 1);
  assert.match(o.downloads[0].filename, /^bug-report-.*\.html$/);
  assert.strictEqual(o.stoppedTracks.length, 1, 'capture indicator released');
  assert.ok(o.sent.some((m) => m.type === 'recording-ended'), 'background told to clear the session');
});

test('a cancelled download still releases the session', async () => {
  const o = loadOffscreen({ downloadRejects: true });

  await o.send({ type: 'start', streamId: 's1' });
  const res = await o.send({ type: 'stop', report: o.report });

  assert.match(res.error, /user cancelled/, 'error surfaced, not swallowed');
  assert.ok(o.sent.some((m) => m.type === 'recording-ended'), 'session released despite the failure');
});

test('a failed recorder start stops the acquired stream before rethrowing', async () => {
  const o = loadOffscreen({ constructorThrows: true });

  const res = await o.send({ type: 'start', streamId: 's1' });

  assert.match(res.error, /MediaRecorder unsupported/);
  assert.strictEqual(o.stoppedTracks.length, 1, 'stream stopped so the tab indicator does not stay lit');
});

test('messages aimed at the service worker are ignored', () => {
  const o = loadOffscreen();

  // The popup and the worker share this channel, so anything without our target
  // must fall through untouched rather than being answered.
  assert.strictEqual(o.raw({ type: 'status' }), undefined);
  assert.strictEqual(o.raw({ type: 'keepalive' }), undefined);
  assert.strictEqual(o.downloads.length, 0);
});
