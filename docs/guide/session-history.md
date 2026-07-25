---
icon: lucide/history
---

# Session history

Session history is an opt-in record of terminal output that outlives the session, remains
searchable, and can be replayed as it was displayed.

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

**Remote output** is recorded byte for byte, including escape sequences, which is what
makes exact replay possible.

**Input is not recorded** unless input capture is enabled for that session. The
terminal-actions menu can start, pause and stop logging mid-session and toggle input
capture.

!!! warning "Echoed commands are still output"

    Typed text returns from the remote as output, so a command containing a token is
    recorded even with input capture off. **Pause logging before displaying secrets.**

## Searching and reading

The history dialog searches the normalized transcript, which is the text with escape
sequences removed, using debounced cursor-paged queries. Filters are **host**, **connection
type** (SSH, local, serial, Telnet) and **date range**.

Opening a session displays its transcript, and allows copying the complete clean log,
pinning the session so it is never evicted, or deleting it.

## Exports

| Button | What you get |
| --- | --- |
| **Raw log** | `<session>.muxlog`, lossless base64 NDJSON, every frame as recorded |
| **Clean log** | `<session>-clean.txt`, the transcript with escape sequences stripped |
| **HTML replay** | `<session>-replay.html`, a self-contained, seekable page that replays the session in a browser |

The HTML replay requires only a browser.

## Storage, quotas and eviction

History is stored outside the application database. A dedicated worker writes framed raw
events into rotated **zstd**-compressed segments, and batches normalized transcript chunks
into a separate FTS5 database.

| Limit | Default |
| --- | --- |
| Total history size | **5 GiB** |
| Free-space reserve | **2 GiB** or **5%** of the disk, whichever is larger |
| Per session | **10** parts of **5 MiB** |
| Age retention | Off (configurable) |

When the quota is reached, the oldest unpinned completed sessions are evicted down to an
85% low-water mark. Active sessions are never evicted. If storage is exhausted, logging
suspends itself and the terminal continues to operate. Usage, quota, retention and the
storage location are shown and adjustable in
[Settings → Session logging](settings.md#session-logging).
