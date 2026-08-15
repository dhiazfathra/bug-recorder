// Service worker: owns recording state, collects console + network logs,
// drives the offscreen document that does the actual video capture.

const MAX_ENTRIES = 5000; // ponytail: flat cap instead of ring-buffer bookkeeping

let session = null; // { tabId, startedAt, description, entries: [], pending: Map }

const add = (entry) => {
  if (!session || session.entries.length >= MAX_ENTRIES) return;
  session.entries.push({ ...entry, at: entry.t - session.startedAt });
};

// --- network (webRequest sees every request, not just fetch/XHR) ---
const filter = { urls: ['<all_urls>'] };
const forTab = (d) => session && d.tabId === session.tabId;

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (forTab(d)) session.pending.set(d.requestId, d.timeStamp);
}, filter);

const finish = (d, status, error) => {
  if (!forTab(d)) return;
  const started = session.pending.get(d.requestId) ?? d.timeStamp;
  session.pending.delete(d.requestId);
  add({
    kind: 'network',
    t: started,
    method: d.method,
    url: d.url,
    resourceType: d.type,
    status,
    error,
    durationMs: Math.round(d.timeStamp - started),
  });
};

chrome.webRequest.onCompleted.addListener((d) => finish(d, d.statusCode), filter);
chrome.webRequest.onErrorOccurred.addListener((d) => finish(d, 0, d.error), filter);

// --- messaging ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'log') {
    if (sender.tab?.id === session?.tabId) add(msg.entry);
    return;
  }
  if (msg.type === 'status') {
    sendResponse({ recording: !!session });
    return true;
  }
  if (msg.type === 'start') {
    start(msg.description).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'recording-ended') {
    session = null;
    chrome.offscreen.closeDocument().catch(() => {});
  }
});

// tab closed/navigated away mid-recording: stream dies with it, so finalize
// and clear state ourselves or the next start() fails on a stale offscreen doc.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId !== tabId) return;
  stop().catch(() => {}).finally(() => {
    session = null;
    chrome.offscreen.closeDocument().catch(() => {});
  });
});

// --- lifecycle ---
async function start(description) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record the captured tab stream with MediaRecorder.',
  });

  session = {
    tabId: tab.id,
    startedAt: Date.now(),
    description,
    url: tab.url,
    entries: [],
    pending: new Map(),
  };
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
}

async function stop() {
  if (!session) return;
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'stop',
    report: {
      description: session.description,
      url: session.url,
      startedAt: session.startedAt,
      durationMs: Date.now() - session.startedAt,
      userAgent: navigator.userAgent,
      entries: session.entries,
    },
  });
}
