const toggle = document.getElementById('toggle');
const description = document.getElementById('description');
const hint = document.getElementById('hint');

// The name is generated from the page at start; the field only appears while
// recording, so it can be corrected before the report is saved.
const paint = (recording, name) => {
  toggle.textContent = recording ? 'Stop and save report' : 'Start recording';
  description.hidden = !recording;
  if (recording && name !== undefined) description.value = name;
  hint.textContent = recording
    ? 'Recording this tab. Reproduce the bug, rename it if you like, then stop.'
    : 'Records the active tab: video, console and network log.';
};

chrome.runtime.sendMessage({ type: 'status' }).then((r) => paint(r?.recording, r?.description));

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  const { recording } = await chrome.runtime.sendMessage({ type: 'status' });
  const res = await chrome.runtime.sendMessage(
    recording ? { type: 'stop', description: description.value } : { type: 'start' }
  );
  toggle.disabled = false;
  if (res?.error) return (hint.textContent = res.error);
  if (recording) window.close();
  else paint(true, res?.description);
});
