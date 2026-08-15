const test = require('node:test');
const assert = require('node:assert');
const { buildReport, escapeHtml } = require('../extension/report.js');

const sample = {
  description: 'Save button <broken>',
  url: 'https://example.com/app?a=1&b=2',
  startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  durationMs: 12400,
  userAgent: 'Mozilla/5.0 "test"',
  video: 'data:video/webm;base64,AAAA',
  entries: [
    { kind: 'console', level: 'error', at: 1200, text: 'boom </script>' },
    { kind: 'network', at: 3400, method: 'POST', url: 'https://api.example.com/save', status: 500, durationMs: 42, resourceType: 'xmlhttprequest' },
  ],
};

test('escapeHtml neutralises markup characters', () => {
  assert.strictEqual(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('report embeds video, metadata and both log kinds', () => {
  const html = buildReport(sample);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /src="data:video\/webm;base64,AAAA"/);
  assert.match(html, /2026-01-02T03:04:05\.000Z/);
  assert.match(html, /12s/);
  assert.ok(html.includes('boom'), 'console entry present');
  assert.ok(html.includes('api.example.com/save'), 'network entry present');
});

test('user-controlled text cannot break out of the document', () => {
  const html = buildReport(sample);
  assert.ok(!html.includes('<broken>'), 'title escaped');
  assert.ok(html.includes('\\u003c/script>'), 'closing tag escaped inside the JSON payload');
  assert.ok(!html.includes('boom </script>'), 'raw closing tag never reaches the document');
});

test('missing optional fields do not throw', () => {
  const html = buildReport({ startedAt: 0, entries: [] });
  assert.ok(html.includes('Untitled bug'));
});
