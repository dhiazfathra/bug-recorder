# ADR-0002: Capture video with `tabCapture` + an offscreen document

## Status
Accepted

## Date
2026-08-15

## Context
Manifest V3 replaced the persistent background page with a service worker, which has no DOM and
therefore cannot hold a `MediaStream` or run `MediaRecorder`. Something with a document has to own
the recording for its whole duration.

## Decision
The popup asks the service worker to start. The service worker calls
`chrome.tabCapture.getMediaStreamId({ targetTabId })` (valid because the popup click is a user
gesture on that tab), creates an **offscreen document** with reason `USER_MEDIA`, and hands it the
stream ID. The offscreen document calls `getUserMedia` with `chromeMediaSource: 'tab'` and runs
`MediaRecorder`. On stop it builds the report and closes itself.

The offscreen document pings the service worker every 20 s. Message traffic resets the worker's idle
timer, so the in-memory log buffer survives recordings longer than 30 seconds.

## Alternatives Considered

### `navigator.mediaDevices.getDisplayMedia()` from an extension page
- Pros: No `tabCapture` permission; can record the whole screen or another window.
- Cons: Adds a second OS-level picker dialog on top of the popup click, and the user can pick a
  surface that isn't the tab whose logs we are collecting — video and logs would disagree.
- Rejected: the video and the logs must describe the same tab.

### Record from a content script injected into the page
- Pros: Same context as the logs.
- Cons: Content scripts die on navigation, taking the recording with them; `tabCapture` streams are
  not available there anyway.
- Rejected: not possible.

### Persist state to `chrome.storage.session` (or IndexedDB) instead of a keepalive
- Pros: The session survives an unexpected worker termination, not just the idle timeout.
- Cons: A write per console line on a hot path, plus resume logic in the worker, the popup, and the
  offscreen document — for a failure mode that only occurs when Chrome kills the worker outright.
- Rejected, knowingly: the keepalive is three lines and covers the common case (the idle timer). We
  accept losing a session to a hard termination rather than carry persistence for every log line. If
  crash reports show real losses, this is the fix.

## Consequences
- Only the active tab is recorded, never the whole screen. Bugs that involve another window or a
  native dialog are out of scope.
- Audio is not captured. `tabCapture` audio mutes the tab for the user unless the stream is piped
  back to an `AudioContext`, which is more machinery than a bug report needs.
- **The session is in memory only.** The keepalive prevents the *idle* shutdown, not every shutdown.
  If Chrome terminates the service worker unexpectedly (crash, update, memory pressure), the log
  buffer and the in-progress session are lost and the recording has to be redone.
- Output is `video/webm` — the only format `MediaRecorder` guarantees in Chrome.
