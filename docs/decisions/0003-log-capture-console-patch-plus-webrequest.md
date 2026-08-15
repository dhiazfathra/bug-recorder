# ADR-0003: Console via MAIN-world patch, network via `webRequest`

## Status
Accepted

## Date
2026-08-15

## Context
The brief asks for "logs similar to inspect element" — the Console and Network panels. Chrome exposes
three ways to get at that data, each with a different cost.

## Decision
Two different mechanisms, each the cheapest one for its own panel:

- **Console** — a content script declared with `"world": "MAIN"` at `document_start` patches
  `console.{log,info,warn,error,debug}` and listens for `error` / `unhandledrejection`. It
  `postMessage`s each entry to a second, isolated-world content script (`relay.js`) that forwards it
  to the service worker, which is the only context allowed to talk to `chrome.runtime`.
- **Network** — `chrome.webRequest` observers (`onBeforeRequest` / `onCompleted` /
  `onErrorOccurred`) in the service worker, filtered to the recorded tab.

## Alternatives Considered

### `chrome.debugger` (Chrome DevTools Protocol) for both
- Pros: Exactly what DevTools shows, including response bodies, initiators, and headers.
- Cons: Shows a permanent "Bug Recorder started debugging this browser" banner over the recorded tab
  — which then appears in the video of every bug report. Cannot attach while DevTools is open, which
  is precisely when a developer is reproducing a bug. Much larger surface.
- Rejected: it degrades the artifact it is meant to improve.

### Patch `fetch` and `XMLHttpRequest` in the MAIN world for network too
- Pros: One mechanism; gives access to request and response bodies.
- Cons: Misses everything not issued from JavaScript — images, stylesheets, fonts, `<script>` tags,
  navigations, beacons — and misses anything issued before the patch lands. Broken images are a
  common bug class.
- Rejected: `webRequest` sees every request with less code.

### `chrome.webRequest` for console too
- Not possible; there is no console equivalent.

## Consequences
- No response bodies and no headers in the network log — method, URL, resource type, status, error,
  and duration only. This is enough to spot a 500, a CORS failure, or a slow call, which covers most
  bug reports.
- Console entries are captured only from frames where the content script ran; a page that loads
  before the extension is installed or enabled contributes nothing until reload.
- Values are serialized to strings at capture time (`JSON.stringify`, with `Error` stacks and
  `bigint` handled). Objects mutated after being logged show their state at log time, unlike DevTools'
  live references — arguably more correct for a bug report.
- The buffer is capped at 5000 entries per recording to bound memory on chatty pages.
- `webRequest` and `<all_urls>` host permissions make this an extension that can see every request on
  every site. It only *records* while a session is active and only for the recorded tab, but the
  permission prompt is broad and users should be told why — see the README.
