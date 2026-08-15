const toggle = document.getElementById('toggle');
const description = document.getElementById('description');
const hint = document.getElementById('hint');

const paint = (recording) => {
  toggle.textContent = recording ? 'Stop and save report' : 'Start recording';
  description.hidden = recording;
  hint.textContent = recording
    ? 'Recording this tab. Reproduce the bug, then stop.'
    : 'Records the active tab: video, console and network log.';
};

chrome.runtime.sendMessage({ type: 'status' }).then((r) => paint(r?.recording));

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  const { recording } = await chrome.runtime.sendMessage({ type: 'status' });
  const res = await chrome.runtime.sendMessage(
    recording ? { type: 'stop' } : { type: 'start', description: description.value }
  );
  toggle.disabled = false;
  if (res?.error) return (hint.textContent = res.error);
  if (recording) window.close();
  else paint(true);
});
