const test = require('node:test');
const assert = require('node:assert');

function loadInject() {
  const posted = [];
  global.window = { postMessage: (m) => posted.push(m) };
  global.addEventListener = () => {};
  global.console = { ...console, log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  delete require.cache[require.resolve('../extension/inject.js')];
  require('../extension/inject.js');

  return { posted, log: (...args) => global.console.log(...args) };
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
