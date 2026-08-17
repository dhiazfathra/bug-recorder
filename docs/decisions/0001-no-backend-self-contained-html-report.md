# ADR-0001: No backend — export one self-contained HTML report

## Status
Accepted

## Date
2026-08-15

## Context
The brief is to recreate Jam (jam.dev) as a browser extension **without a backend**, as simply as
possible. Jam's own value chain is: capture → upload → share a `jam.dev/...` link. The sharing half
requires an account, storage, and an authenticated API.

The brief also asked to consider uploading to a "free thing" so others can click a link, with the
explicit escape hatch: *if that requires the maintainer's intervention, skip it and work locally.*

Every free host that would accept a multi-megabyte video from an extension needs at minimum an API
token owned by a human (Catbox, file.io, 0x0.st rate-limit or require accounts; GitHub Gists cap at
~100 MB but need a PAT and are text-oriented; S3/R2 need credentials). All of them require the
maintainer to create and paste a secret, and all of them turn a zero-config extension into one with
a configuration surface, a network failure mode, and a data-exfiltration risk.

## Decision
No backend and no upload. On stop, the extension writes a **single self-contained `.html` file** to
the user's Downloads folder: the video is embedded as a `data:` URL, the console and network logs as
an inline JSON payload, and the viewer UI as inline CSS/JS.

The file is the shareable artifact. Anyone can open it in any browser, offline, with no extension and
no account. Sharing is whatever the user already uses — Slack, email, a drive link.

## Alternatives Considered

### Upload to a free file host
- Pros: Reproduces Jam's clickable-link flow.
- Cons: Needs a maintainer-owned token, adds config + network failure modes, and silently ships
  potentially sensitive recordings to a third party.
- Rejected: explicitly out of scope per the brief's escape hatch.

### Download video and logs as separate files
- Pros: Smaller files, no base64 inflation.
- Cons: The recipient has to correlate a `.webm` with a `.json` by hand — the correlation *is* the
  product.
- Rejected: breaks the single-artifact property that makes the report shareable.

### Store reports in `chrome.storage` and view them in an extension page
- Pros: No download step.
- Cons: Not shareable at all; `chrome.storage.local` quota is far below video size.
- Rejected: fails the core requirement.

## Consequences
- Base64 inflates the video by ~33%. Fine for the minute-scale recordings this targets; a 10-minute
  4K recording will produce an unwieldy file. Documented as a known ceiling in the README.
- The report has no server-side redaction. Whatever was on screen and in the logs is in the file, and
  the user is the one who decides who receives it.
- Zero infrastructure to run, pay for, or secure.
