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

### Persist state to `chrome.storage.session` instead of a keepalive
- Pros: Correct even if the worker is killed outright.
- Cons: A write per console line; more code for a failure mode the keepalive already covers.
- Rejected: the keepalive is three lines.

## Consequences
- Only the active tab is recorded, never the whole screen. Bugs that involve another window or a
  native dialog are out of scope.
- Audio is not captured. `tabCapture` audio mutes the tab for the user unless the stream is piped
  back to an `AudioContext`, which is more machinery than a bug report needs.
- Output is `video/webm` — the only format `MediaRecorder` guarantees in Chrome.
