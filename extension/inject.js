// MAIN world: patch console + error events so we see what DevTools shows.
(() => {
  const send = (entry) =>
    window.postMessage({ __bugRecorder: true, entry: { ...entry, t: Date.now() } }, '*');

  const stringify = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
    try {
      // stringify returns undefined for undefined/function/symbol -> blank entry
      const s = JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? String(val) : val));
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      send({ kind: 'console', level, text: args.map(stringify).join(' ') });
      original(...args);
    };
  }

  addEventListener('error', (e) =>
    send({ kind: 'console', level: 'error', text: `Uncaught ${stringify(e.error ?? e.message)}` })
  );
  addEventListener('unhandledrejection', (e) =>
    send({ kind: 'console', level: 'error', text: `Unhandled rejection: ${stringify(e.reason)}` })
  );
})();
