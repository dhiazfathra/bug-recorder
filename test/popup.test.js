const test = require('node:test');
const assert = require('node:assert');

// popup.js only touches getElementById, one click listener and window.close,
// so a hand-rolled stub is smaller than pulling in a DOM implementation.
function loadPopup(respond) {
  const els = {
    toggle: { textContent: '', disabled: false, addEventListener: (_, fn) => { els.toggle.click = fn; } },
    description: { value: '', hidden: false },
    hint: { textContent: '' },
  };
  const closed = { count: 0 };
  const sent = [];

  global.document = { getElementById: (id) => els[id] };
  global.window = { close: () => { closed.count++; } };
  global.chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return respond(msg); },
    },
  };

  delete require.cache[require.resolve('../extension/popup.js')];
  require('../extension/popup.js');

  // the load-time status call resolves a microtask later
  const settled = () => new Promise((r) => setImmediate(r));
  return { els, closed, sent, settled };
}

const answers = (map) => (msg) => Promise.resolve(map[msg.type]);

test('the idle popup hides the name field and offers to start', async () => {
  const p = loadPopup(answers({ status: { recording: false } }));
  await p.settled();

  assert.strictEqual(p.els.toggle.textContent, 'Start recording');
  assert.strictEqual(p.els.description.hidden, true, 'no name is asked for up front');
});

test('reopening mid-recording prefills the generated name', async () => {
  const p = loadPopup(answers({ status: { recording: true, description: 'Bug on Checkout' } }));
  await p.settled();

  assert.strictEqual(p.els.description.hidden, false);
  assert.strictEqual(p.els.description.value, 'Bug on Checkout');
  assert.strictEqual(p.els.toggle.textContent, 'Stop and save report');
});

test('starting reveals the name returned by the worker', async () => {
  const p = loadPopup(answers({ status: { recording: false }, start: { ok: true, description: 'Bug on Acme' } }));
  await p.settled();
  await p.els.toggle.click();

  assert.strictEqual(p.els.description.value, 'Bug on Acme');
  assert.strictEqual(p.els.toggle.disabled, false);
});

test('stopping sends the edited name and closes the popup', async () => {
  const p = loadPopup(answers({ status: { recording: true, description: 'Bug on Checkout' } , stop: { ok: true } }));
  await p.settled();
  p.els.description.value = 'Coupon field rejects valid codes';
  await p.els.toggle.click();

  const stop = p.sent.find((m) => m.type === 'stop');
  assert.strictEqual(stop.description, 'Coupon field rejects valid codes');
  assert.strictEqual(p.closed.count, 1);
});

test('an error reported by the worker is shown and the button stays usable', async () => {
  const p = loadPopup(answers({ status: { recording: false }, start: { error: 'No active tab' } }));
  await p.settled();
  await p.els.toggle.click();

  assert.strictEqual(p.els.hint.textContent, 'No active tab');
  assert.strictEqual(p.els.toggle.disabled, false);
});

test('a rejected status call surfaces the error instead of hanging the button', async () => {
  const p = loadPopup((msg) => msg.type === 'status'
    ? Promise.reject(new Error('Could not establish connection'))
    : Promise.resolve({ ok: true }));
  await p.settled();
  await p.els.toggle.click();

  assert.match(p.els.hint.textContent, /Could not establish connection/);
  assert.strictEqual(p.els.toggle.disabled, false, 'a dead worker must not leave the button stuck');
});

test('a rejected start/stop call surfaces the error instead of hanging the button', async () => {
  const p = loadPopup((msg) => msg.type === 'status'
    ? Promise.resolve({ recording: false })
    : Promise.reject(new Error('worker gone')));
  await p.settled();
  await p.els.toggle.click();

  assert.match(p.els.hint.textContent, /worker gone/);
  assert.strictEqual(p.els.toggle.disabled, false);
  assert.strictEqual(p.closed.count, 0, 'a failed stop must not close the popup');
});

test('a rejected load-time status call is reported, not swallowed', async () => {
  const p = loadPopup(() => Promise.reject(new Error('worker asleep')));
  await p.settled();

  assert.match(p.els.hint.textContent, /worker asleep/);
});
