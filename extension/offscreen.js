// Offscreen document: the only place in MV3 that can hold a MediaStream + MediaRecorder.

let recorder = null;
let chunks = [];
let keepAlive = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const done = (r) => sendResponse(r ?? { ok: true });
  if (msg.type === 'start') startCapture(msg.streamId).then(() => done(), (e) => done({ error: String(e) }));
  if (msg.type === 'stop') stopCapture(msg.report).then(() => done(), (e) => done({ error: String(e) }));
  return true;
});

async function startCapture(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  // Messaging resets the service worker idle timer, so state survives a long recording.
  keepAlive = setInterval(() => chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {}), 20000);
}

async function stopCapture(report) {
  clearInterval(keepAlive);
  if (!recorder) return;
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.stop();
  recorder.stream.getTracks().forEach((t) => t.stop());
  await stopped;

  const video = await blobToDataUrl(new Blob(chunks, { type: 'video/webm' }));
  recorder = null;
  chunks = [];

  const html = new Blob([buildReport({ ...report, video })], { type: 'text/html' });
  await chrome.downloads.download({
    url: URL.createObjectURL(html),
    filename: `bug-report-${new Date(report.startedAt).toISOString().replace(/[:.]/g, '-')}.html`,
    saveAs: true,
  });
  chrome.runtime.sendMessage({ type: 'recording-ended' }).catch(() => {});
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
