---
icon: lucide/search
---

# Quick launcher

++ctrl+k++ (++cmd+k++ on macOS) opens a single search box covering everything Muxus knows
about, and acts on the selected result.

<figure markdown="span">
  ![The quick launcher](../assets/screenshots/quick-launcher.png#only-light){ .shadow }
  ![The quick launcher](../assets/screenshots/quick-launcher-dark.png#only-dark){ .shadow }
  <figcaption>Hosts, tabs, files, workspaces, commands, tunnels and history in one result list.</figcaption>
</figure>

## What it searches

| Category | Action |
| --- | --- |
| **Saved hosts** (SSH, Telnet, serial) | Connect |
| **Open tabs** | Switch to it, or reconnect if it dropped |
| **Editor files** open in a session | Jump to the file |
| **Workspaces** | Open it |
| **Saved command buttons** | Send the command to the focused terminal |
| **Keyboard commands** (the whole keymap) | Run it, with its chord shown |
| **Tunnels** | Start or stop it in place |
| **Session history** | Open the retained session |
| **App actions** (settings, history, workspaces, shortcuts) | Open it |
| **Anything that looks like a target** | Connect ad-hoc to `user@host:port` |

Matching is token-based: every entered word must appear somewhere in the entry, so `prod
db` matches `db-01` in the `Production/Data` folder. Results are ranked, and ++enter++ runs
the highest-ranked one.

## Keys

| Key | Action |
| --- | --- |
| ++ctrl+k++ | Open (and close) |
| ++up++ / ++down++ | Move through results |
| ++enter++ | Run the highlighted result |
| ++esc++ | Close |

Each row states the action ++enter++ will perform: **connect**, **switch**, **tunnel** or
**action**.

!!! tip "The sidebar search box is the other half"

    In the sidebar, the search box filters the tree and connects on ++enter++, including
    ad-hoc `user@host` targets. The quick launcher extends the same behaviour to every
    other category, and works with the sidebar hidden.
