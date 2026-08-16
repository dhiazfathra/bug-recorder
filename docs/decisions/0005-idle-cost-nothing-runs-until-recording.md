# ADR-0005: An idle extension costs nothing

## Status
Accepted

## Date
2026-08-16

## Context

The extension was reported to make Chrome feel laggy at startup. It was, and the cause was
that everything it does ran all the time, not only while recording:

- `chrome.webRequest.onBeforeRequest` / `onCompleted` / `onErrorOccurred` were registered at
  worker start with `{ urls: ['<all_urls>'] }`. Every request the *whole browser* made woke the
  service worker and ran three callbacks, which then discarded the event because no session
  existed.
- `inject.js` patched `console` in the MAIN world of every frame of every page and, on every call,
  ran `JSON.stringify` over the arguments and `postMessage`d the result. `relay.js` then forwarded
  each one to the worker over IPC — again to be discarded.

A session restore is exactly the pathological case: many tabs, all loading at once, each firing
dozens of requests and console calls before anything is on screen.

Measured with `npm run bench` (12 tabs opened simultaneously, 300 `console.log` + 40 fetches per
page, median of 3 runs, Chrome for Testing 152):

| | without extension | with extension | overhead |
|---|---|---|---|
| 12 tabs opened at once | 2049ms | 2914ms | **+42%** |
| 300 `console.log` in-page | 7.0ms | 12.2ms | **+75%** |

An instrumented worker confirmed the mechanism: while recording nothing at all, it received 992
`webRequest` events and 2400 console messages across 8 page loads.

## Decision

Nothing runs until a recording starts.

- `webRequest` listeners are attached in `start()` and detached in `release()`, filtered to
  `{ tabId }` — the one tab being recorded — instead of `<all_urls>`.
- `inject.js` still installs its `console` patch at `document_start` (it must, to catch the first
  call after Start), but the patch is inert: it checks one boolean and calls through to the
  original. No serializing, no posting.
- The worker pushes capture state to the page with `chrome.tabs.sendMessage({ type: 'capture' })`
  on start and on every path that ends a session.

## Alternatives Considered

### Ask for the state from the content script on load
`relay.js` could call `sendMessage({ type: 'status' })` when it loads. Rejected: that wakes the
service worker once per frame of every page — the same browser-wide cost, moved from `webRequest`
to `runtime`. State is pushed, never polled.

### Restore the original `console` when idle, rather than checking a flag
Would make the idle cost exactly zero instead of ~7us per call. Rejected: pages wrap `console`
themselves, and swapping the property back and forth risks clobbering a wrapper the page installed
after ours. A predictable boolean is worth more than the last few microseconds.

### Register `webRequest` once and filter inside the callback
This was the original design. The callback filtering was never the expense; being woken at all was.

## Consequences

Re-measured after the change:

| | without extension | with extension | overhead |
|---|---|---|---|
| 12 tabs opened at once | 2771ms | 2315ms | none measurable |
| 300 `console.log` in-page | 7.3ms | 9.2ms | +27% (~7us per call) |

- Console calls made *before* Start are not captured. They never were: the worker already dropped
  entries when no session existed.
- A residual ~7us per `console.log` remains on every page, from the inert wrapper. It is the price
  of catching the first call after Start without re-injecting.
- `webRequest` listeners are now registered outside the worker's initial evaluation. If the worker
  is terminated mid-recording they are not restored — the same residual risk ADR-0002 already
  accepts for the in-memory log buffer, and with the same trigger to revisit.
- A page could postMessage `__bugRecorderSet: true` at itself to switch its own capture on. The
  worker discards entries when no session is running, so this leaks nothing; it costs a page only
  the serializing it opted into.
