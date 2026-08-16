// Service worker: owns recording state, collects console + network logs,
// drives the offscreen document that does the actual video capture.

const MAX_ENTRIES = 5000; // ponytail: flat cap instead of ring-buffer bookkeeping

let session = null; // { tabId, startedAt, description, entries: [], pending: Map }

const add = (entry) => {
  if (!session || session.entries.length >= MAX_ENTRIES) return;
  session.entries.push({ ...entry, at: entry.t - session.startedAt });
};

// --- network (webRequest sees every request, not just fetch/XHR) ---
//
// Listeners are attached on start and detached on stop, filtered to the one tab
// being recorded. Left attached to <all_urls> they wake this worker for every
// request the whole browser makes, which is most of what a session restore is.
// See ADR-0005.
const forTab = (d) => session && d.tabId === session.tabId;

const onBefore = (d) => {
  // Requests that never complete (stalled, aborted below the API) would grow
  // pending forever, so cap it the same way entries are capped.
  if (forTab(d) && session.pending.size < MAX_ENTRIES) session.pending.set(d.requestId, d.timeStamp);
};

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

const onDone = (d) => finish(d, d.statusCode);
const onFail = (d) => finish(d, 0, d.error);

const watchNetwork = (tabId) => {
  const filter = { urls: ['<all_urls>'], tabId };
  chrome.webRequest.onBeforeRequest.addListener(onBefore, filter);
  chrome.webRequest.onCompleted.addListener(onDone, filter);
  chrome.webRequest.onErrorOccurred.addListener(onFail, filter);
};

const unwatchNetwork = () => {
  chrome.webRequest.onBeforeRequest.removeListener(onBefore);
  chrome.webRequest.onCompleted.removeListener(onDone);
  chrome.webRequest.onErrorOccurred.removeListener(onFail);
};

// Content scripts stay inert until told a recording is running.
const setCapture = (tabId, on) =>
  chrome.tabs.sendMessage(tabId, { type: 'capture', on }).catch(() => {});

// Every path that ends a session goes through here: leaving the listeners
// attached or the page still serializing is the whole cost this avoids.
const release = () => {
  if (!session) return;
  const { tabId } = session;
  session = null;
  unwatchNetwork();
  setCapture(tabId, false);
};

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
    release();
    chrome.offscreen.closeDocument().catch(() => {});
  }
});

// tab closed/navigated away mid-recording: stream dies with it, so finalize
// and clear state ourselves or the next start() fails on a stale offscreen doc.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId !== tabId) return;
  stop().catch(() => {}).finally(() => {
    release();
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
    // valid URLs can still have no hostname: about:blank, data:, file:
    const { hostname } = new URL(tab.url);
    return hostname ? `Bug on ${hostname}` : 'Untitled bug';
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

  watchNetwork(tab.id);
  setCapture(tab.id, true);

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
    // Otherwise session + offscreen doc leak and no later stop can ever end them,
    // and the listeners stay attached costing every page in the browser.
    release();
    await chrome.offscreen.closeDocument().catch(() => {});
    throw e;
  }
}

async function stop(description) {
  if (!session) return;
  try {
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
  } catch (e) {
    // Normally 'recording-ended' releases the session once the report is saved.
    // If the offscreen document never answers that never arrives, leaving the
    // listeners attached to every page and blocking the next start.
    release();
    await chrome.offscreen.closeDocument().catch(() => {});
    throw e;
  }
}
