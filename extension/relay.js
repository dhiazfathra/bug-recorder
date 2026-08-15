// Isolated world: forward MAIN-world console entries to the service worker.
addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.__bugRecorder) return;
  chrome.runtime.sendMessage({ type: 'log', entry: e.data.entry }).catch(() => {});
});
