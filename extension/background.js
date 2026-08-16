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
  // Requests that never complete (stalled, aborted below the API) would grow
  // pending forever, so cap it the same way entries are capped.
  if (forTab(d) && session.pending.size < MAX_ENTRIES) session.pending.set(d.requestId, d.timeStamp);
}, filter);

const finish = (d, status, error) => {
  if (!forTab(d)) return;
  const started = session.pending.get(d.requestId);
  if (started === undefined) return; // untracked (pre-recording or dropped by the cap)
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
    sendResponse({ recording: !!session, description: session?.description });
    return true;
  }
  if (msg.type === 'start') {
    start().then(() => sendResponse({ ok: true, description: session.description }),
      (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'stop') {
    stop(msg.description).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String(e) }));
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

// Named from the page so a report is identifiable without anyone typing
// anything; the popup lets you rewrite it before saving.
const nameFor = (tab) => {
  const title = tab.title?.trim();
  if (title) return `Bug on ${title}`;
  try {
    return `Bug on ${new URL(tab.url).hostname}`;
  } catch {
    return 'Untitled bug';
  }
};

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  session = {
    tabId: tab.id,
    startedAt: Date.now(),
    description: nameFor(tab),
    url: tab.url,
    entries: [],
    pending: new Map(),
  };

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record the captured tab stream with MediaRecorder.',
    });
    // The offscreen listener reports failures in the response rather than rejecting.
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
    if (res?.error) throw new Error(res.error);
  } catch (e) {
    // Otherwise session + offscreen doc leak and no later stop can ever end them.
    session = null;
    await chrome.offscreen.closeDocument().catch(() => {});
    throw e;
  }
}

async function stop(description) {
  if (!session) return;
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'stop',
    report: {
      description: description?.trim() || session.description,
      url: session.url,
      startedAt: session.startedAt,
      durationMs: Date.now() - session.startedAt,
      userAgent: navigator.userAgent,
      entries: session.entries,
    },
  });
}
