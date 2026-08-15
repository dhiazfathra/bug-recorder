# Bug Recorder

A minimal, backend-free recreation of [Jam](https://jam.dev): a Chrome extension that records the
active tab as video while collecting its console and network logs, then exports **one self-contained
HTML file** containing all three. Open it in any browser, share it however you already share files —
no account, no server, no extension needed on the other end.

## Quick start

Chrome 116 or newer is required — earlier versions bind `tabCapture` stream IDs to the frame that
created them, so the offscreen document cannot use them.

1. Clone the repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the
   `extension/` folder.
3. Pin the extension, open the page with the bug, click the icon.
4. Type what the bug is, click **Start recording**, reproduce it.
5. Click the icon again, **Stop and save report**. Chrome asks where to save
   `bug-report-<timestamp>.html`.
6. Open that file, or send it to whoever needs to fix the bug.

## What the report contains

| | |
|---|---|
| Video | The recorded tab, `video/webm`, embedded as a data URL |
| Console | `console.log/info/warn/debug/error`, uncaught errors, unhandled rejections — timestamped against the recording |
| Network | Every request the tab made: method, URL, resource type, status (or error), duration |
| Metadata | Page URL, start time, duration, user agent, your description |

The right-hand panel filters between All / Console / Network. Timestamps are relative to the start of
the video, so a log line at `3.4s` is the one that fired at `3.4s` in the player.

## Commands

| Command | Description |
|---|---|
| `npm install` | Install the dev dependencies (ESLint only — the extension itself has none) |
| `npm ci` | Install them exactly as pinned in `package-lock.json` |
| `npm test` | Run all automated tests |
| `npm run e2e:setup` | Download Chrome for Testing 152.0.7977.42 (once, before `test:e2e`) |
| `npm run test:e2e` | Run the browser tests against a really-installed extension |
| `npm run lint` | Run ESLint |

## Architecture

```
popup.js  ──start/stop──▶  background.js (service worker)
                            │  ├─ chrome.webRequest ──▶ network log
                            │  ├─ relay.js ◀── inject.js (MAIN world console patch)
                            │  └─ chrome.tabCapture.getMediaStreamId
                            ▼
                          offscreen.js  ── MediaRecorder ──▶ report.js ──▶ .html download
```

Seven files, no build step, no runtime dependencies. The reasoning behind each piece is in
[`docs/decisions/`](docs/decisions):

- [ADR-0001](docs/decisions/0001-no-backend-self-contained-html-report.md) — no backend; the report file *is* the shareable link
- [ADR-0002](docs/decisions/0002-tab-capture-via-offscreen-document.md) — `tabCapture` + offscreen document for video under MV3
- [ADR-0003](docs/decisions/0003-log-capture-console-patch-plus-webrequest.md) — console via MAIN-world patch, network via `webRequest`, and why not `chrome.debugger`
- [ADR-0004](docs/decisions/0004-scope-cut-from-jam.md) — what was cut from Jam, and how to add it back

## Testing status

`npm test` covers the report builder, the service-worker log collection and lifecycle, console
serialization, and the offscreen control flow (cleanup on a failed recorder start, `recording-ended`
firing even when the download is cancelled). Those offscreen tests fake `MediaRecorder`,
`getUserMedia`, `FileReader` and `URL.createObjectURL` — they prove the control flow, **not that
Chrome actually records a tab**.

`npm run test:e2e` installs the extension into a real (pinned) Chrome and checks what unit tests
cannot: that the manifest loads, that the MAIN-world console patch and relay content script really
deliver entries to the service worker on a live page, and that a generated report renders its video
element and both log kinds. Run `npm run e2e:setup` once first; it downloads the exact build the
suite is pinned to, **Chrome for Testing 152.0.7977.42**, so every machine runs the same browser.
The pin also matters for a second reason: Chrome 137+ ignores `--load-extension` unless
`--disable-features=DisableLoadExtensionCommandLineSwitch` is passed, and regular Chrome no longer
honours that escape hatch at all.

**The video capture path still has no automated coverage.** `chrome.tabCapture` only issues a stream
after the extension has been *invoked* on the tab — the `activeTab` grant — and that invocation must
come from a genuine click on the toolbar icon. CDP cannot synthesize input into browser chrome, so no
harness can grant it; `getMediaStreamId` fails with *"Extension has not been invoked for the current
page"*. After changing `offscreen.js` or the `tabCapture` handshake, record something by hand.

## Known limits

- **Active tab only.** No screen or window capture, no audio.
- **No response bodies or headers** in the network log — status, timing, and resource type only.
- **Long recordings produce large files.** Base64 adds ~33% on top of the video; this targets
  minute-scale recordings, not hour-long sessions.
- **Console capture starts when the content script runs.** Pages already open when the extension is
  installed or reloaded need a refresh.
- **Reports are unredacted.** The video and logs contain whatever was on screen and in the console,
  including tokens and personal data. Check a report before sending it.

## Permissions

`activeTab` is what lets `tabCapture` hand out a stream: Chrome only allows capture after you invoke
the extension by clicking its toolbar icon, and without this permission that invocation grants
nothing and recording fails to start. `<all_urls>` plus `webRequest` are needed to observe console
and network activity on whichever page you are debugging. Nothing is recorded until you press Start, only the recorded tab is observed, and
nothing ever leaves your machine — the extension makes no network requests of its own.
