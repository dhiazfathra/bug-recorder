# ADR-0004: What was deliberately cut from Jam

## Status
Accepted

## Date
2026-08-15

## Context
Jam captures four categories: visual context, device/browser metadata, developer logs, and user
events — plus screenshot mode, Instant Replay, annotation, an SDK for custom logs, and integrations
with Jira/Linear/Slack/GitHub. The brief asks for the *bare minimum*: video, console log, network
log.

## Decision
Ship exactly the three requested capture types plus the metadata that is free to collect (page URL,
timestamp, duration, user agent). Everything else is cut.

Cut, and what it would take to add:

| Jam feature | Why cut | Add by |
|---|---|---|
| Screenshot mode | Video is a superset | `chrome.tabs.captureVisibleTab` and skip `MediaRecorder` |
| Instant Replay (last 2 min) | Requires always-on recording — a background CPU and privacy cost paid on every page | `MediaRecorder` in timeslice mode into a ring buffer, started on install |
| User-event log (clicks, navigation, input) | Not requested; the video already shows it | Listeners in `inject.js` emitting `{kind:'event'}` — the report renderer already handles arbitrary kinds |
| Annotation tools | Not requested | Canvas overlay in the report viewer |
| SDK / custom logs | No backend to receive them | The console patch already captures anything the app logs |
| Issue-tracker integrations | Needs a backend and OAuth | See ADR-0001 |
| Accounts, hosted links | Explicitly out of scope | See ADR-0001 |

## Consequences
- The extension is ~250 lines across seven files with no runtime dependencies.
- The report's entry list renders from a `kind` discriminator, so a fourth log type is additive, not
  a refactor.
