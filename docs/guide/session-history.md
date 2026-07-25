---
icon: lucide/history
---

# Session history

Scrollback is finite and dies with the tab. Session history is the opposite: an **opt-in**
record of terminal output that survives the session, is searchable months later, and can be
replayed exactly as it looked.

<figure markdown="span">
  ![The session history dialog](../assets/screenshots/history.png#only-light){ .shadow }
  ![The session history dialog](../assets/screenshots/history-dark.png#only-dark){ .shadow }
  <figcaption>Full-text search across retained sessions, with host, date and connection-type filters.</figcaption>
</figure>

!!! info "Off until you turn it on"

    A fresh install records nothing. Enable it globally in
    [Settings → Session logging](settings.md#session-logging), or per host in the
    [host editor](adding-hosts.md#session-logging-highlighting).

## What is recorded

**Remote output**, byte for byte, including the escape sequences — that is what makes an
exact replay possible.

**Your keystrokes are not**, unless you explicitly turn on input capture for that session.
The terminal-actions menu can start, pause and stop logging mid-session, and toggle input
capture, so you can pause before pasting a secret.

!!! warning "Echoed commands are still output"

    What you type comes back from the remote as output, so a command containing a token is
    recorded even with input capture off. **Pause logging before displaying secrets.**

## Searching and reading

The history dialog searches the normalized transcript — the text without the escape
sequences — with debounced, cursor-paged queries, so a large history stays responsive.
Filter by **host**, **connection type** (SSH, local, serial, Telnet) and **date range**.

Open a session to read its transcript, copy the complete clean log, **pin** it so it is
never evicted, or delete it.

## Exports

| Button | What you get |
| --- | --- |
| **Raw log** | `<session>.muxlog` — lossless base64 NDJSON, every frame exactly as recorded |
| **Clean log** | `<session>-clean.txt` — the transcript with the escape sequences stripped |
| **HTML replay** | `<session>-replay.html` — a self-contained, seekable page that replays the session in a browser |

The HTML replay needs nothing but a browser: it is the right thing to attach to an incident
report.

## Storage, quotas and eviction

History is deliberately kept **out of the application database**: a dedicated worker writes
framed raw events into rotated **zstd**-compressed segments, and batches normalized
transcript chunks into a separate FTS5 database.

The defaults are conservative:

| Limit | Default |
| --- | --- |
| Total history size | **5 GiB** |
| Free-space reserve | **2 GiB** or **5%** of the disk, whichever is larger |
| Per session | **10** parts of **5 MiB** |
| Age retention | Off (configurable) |

When the quota is reached, the oldest **unpinned, completed** sessions are evicted down to
an 85% low-water mark. Active sessions are never evicted, and if storage is genuinely
exhausted logging suspends itself — **the terminal keeps working**. Usage, quota, retention
and the storage location are all visible and adjustable in
[Settings → Session logging](settings.md#session-logging).
