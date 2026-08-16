const test = require('node:test');
const assert = require('node:assert');

function loadInject({ capturing = true } = {}) {
  const posted = [];
  const listeners = {};
  global.window = { postMessage: (m) => posted.push(m) };
  global.addEventListener = (type, fn) => { listeners[type] = fn; };
  global.console = { ...console, log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  delete require.cache[require.resolve('../extension/inject.js')];
  require('../extension/inject.js');

  // relay.js flips the patch on once a recording starts
  const setCapture = (on) => listeners.message({ source: global.window, data: { __bugRecorderSet: on } });
  if (capturing) setCapture(true);

  return { posted, listeners, setCapture, log: (...args) => global.console.log(...args) };
}

test('values JSON.stringify cannot represent fall back to String()', () => {
  const { posted, log } = loadInject();

  log(undefined);
  log(function named() {});
  log(Symbol('sym'));
  log(undefined, 'tail');

  assert.deepStrictEqual(posted.map((p) => p.entry.text), [
    'undefined',
    'function named() {}',
    'Symbol(sym)',
    'undefined tail',
  ]);
});

test('representable values still serialize as JSON', () => {
  const { posted, log } = loadInject();

  log({ a: 1 });
  log(null);
  log(10n);

  assert.deepStrictEqual(posted.map((p) => p.entry.text), ['{"a":1}', 'null', '"10"']);
});

test('an idle page pays nothing: no serializing, no posting', () => {
  const { posted, log, listeners } = loadInject({ capturing: false });

  // getter throws if anything tries to serialize it while idle
  const hostile = { get boom() { throw new Error('serialized while idle'); } };
  log('noise', hostile);
  listeners.error({ error: new Error('x') });
  listeners.unhandledrejection({ reason: 'x' });

  assert.deepStrictEqual(posted, [], 'nothing reaches the worker unless recording');
});

test('capture switches back off when the recording stops', () => {
  const { posted, log, setCapture } = loadInject();

  log('during');
  setCapture(false);
  log('after');

  assert.deepStrictEqual(posted.map((p) => p.entry.text), ['during']);
});

test('a cross-window message cannot switch capture on', () => {
  const { posted, log, listeners } = loadInject({ capturing: false });

  listeners.message({ source: { some: 'other frame' }, data: { __bugRecorderSet: true } });
  log('still idle');

  assert.deepStrictEqual(posted, [], 'only same-window messages flip the switch');
});
