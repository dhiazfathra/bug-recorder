// Isolated world: forward MAIN-world console entries to the service worker, and
// tell the MAIN-world patch when to bother producing them at all.
//
// State is pushed by the worker, never polled: asking on load would wake the
// service worker once per frame of every page browser-wide. See ADR-0005.
addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.__bugRecorder) return;
  chrome.runtime.sendMessage({ type: 'log', entry: e.data.entry }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture') window.postMessage({ __bugRecorderSet: msg.on }, '*');
});
