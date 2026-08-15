// Builds one self-contained HTML file: video + console/network log, no server needed.
// Loaded both as a classic script in the offscreen document and via require() in tests.

function buildReport(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Bug report — ${escapeHtml(data.description || 'Untitled')}</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; display: grid; grid-template-columns: minmax(0,3fr) minmax(0,2fr); height: 100vh; }
  @media (max-width: 900px) { body { grid-template-columns: 1fr; height: auto; } }
  section { overflow: auto; padding: 1rem; }
  video { width: 100%; background: #000; border-radius: 8px; }
  h1 { font-size: 1.1rem; margin: .75rem 0 .25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem; font-size: .8rem; margin: 0; }
  dt { opacity: .6; }
  dd { margin: 0; overflow-wrap: anywhere; }
  nav button { font: inherit; padding: .25rem .75rem; margin-right: .25rem; cursor: pointer; }
  nav button[aria-pressed="true"] { font-weight: 700; }
  ul { list-style: none; margin: .75rem 0 0; padding: 0; font: .78rem/1.5 ui-monospace, monospace; }
  li { border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: .35rem 0; display: flex; gap: .5rem; }
  .at { opacity: .5; flex: none; }
  .msg { overflow-wrap: anywhere; white-space: pre-wrap; }
  .error, .status-4, .status-5 { color: #d33; }
  .warn { color: #b80; }
</style></head><body>
<section>
  <video controls src="${data.video || ''}"></video>
  <h1>${escapeHtml(data.description || 'Untitled bug')}</h1>
  <dl>
    <dt>URL</dt><dd>${escapeHtml(data.url || '')}</dd>
    <dt>Recorded</dt><dd>${new Date(data.startedAt).toISOString()}</dd>
    <dt>Duration</dt><dd>${Math.round((data.durationMs || 0) / 1000)}s</dd>
    <dt>User agent</dt><dd>${escapeHtml(data.userAgent || '')}</dd>
  </dl>
</section>
<section>
  <nav>
    <button data-filter="all" aria-pressed="true">All</button>
    <button data-filter="console" aria-pressed="false">Console</button>
    <button data-filter="network" aria-pressed="false">Network</button>
  </nav>
  <ul id="entries"></ul>
</section>
<script id="data" type="application/json">${json}</script>
<script>
  const entries = JSON.parse(document.getElementById('data').textContent).entries || [];
  const list = document.getElementById('entries');
  const time = (ms) => (ms / 1000).toFixed(1).padStart(6) + 's';
  const render = (filter) => {
    list.replaceChildren(...entries
      .filter((e) => filter === 'all' || e.kind === filter)
      .map((e) => {
        const li = document.createElement('li');
        const at = document.createElement('span');
        at.className = 'at';
        at.textContent = time(e.at);
        const msg = document.createElement('span');
        msg.className = 'msg ' + (e.kind === 'console' ? e.level : 'status-' + String(e.status)[0]);
        msg.textContent = e.kind === 'console'
          ? '[' + e.level + '] ' + e.text
          : (e.status || e.error) + ' ' + e.method + ' ' + e.url + ' (' + e.durationMs + 'ms, ' + e.resourceType + ')';
        li.append(at, msg);
        return li;
      }));
  };
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    render(b.dataset.filter);
  }));
  render('all');
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

if (typeof module !== 'undefined') module.exports = { buildReport, escapeHtml };
