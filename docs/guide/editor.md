---
icon: lucide/file-pen
---

# Remote editor

Double-click a file in the [file browser](files.md) and it opens in a real editor — the
same [Monaco](https://microsoft.github.io/monaco-editor/) that powers VS Code — reading
and writing over the **live SSH transport** of that session.

<figure markdown="span">
  ![Editing a remote file with Monaco](../assets/screenshots/remote-editor.png#only-light){ .shadow }
  ![Editing a remote file with Monaco](../assets/screenshots/remote-editor-dark.png#only-dark){ .shadow }
  <figcaption>No sync folder, no scp round-trip, no second login.</figcaption>
</figure>

## What you get

- Monaco's **complete built-in syntax catalog**, plus full language services for
  **JavaScript/TypeScript, JSON, HTML and CSS**: diagnostics, completion, hover,
  formatting.
- Folding, the minimap, sticky scroll, multi-cursor editing, find & replace, and Monaco's
  own command palette (++f1++).
- Per-file **undo history and view state**, so switching between open files puts you back
  where you were.
- Language mode, indentation and end-of-line sequence are switchable from the status bar.
- **Save** (++ctrl+s++) and **Save all**; unsaved files are marked in the file list.

Several files stay open at once inside the tab, alongside the terminal — the tab keeps
both, and switching back to the shell is one click.

## Conflict protection

Saving carries the modification time the file had when it was read. If the file changed on
the remote in the meantime, the save is refused and the editor tells you so, offering
**Reload from remote** — your work is never silently written over someone else's, and
theirs is never silently written over yours.

## When to reach for it

The editor is for the edit you would otherwise do in `vi` over a laggy link: a config
tweak, a compose file, a systemd unit. For anything that wants a project — a language
server, a test run, a git history — use your own editor's remote support. Muxus is
deliberately a *file* editor, not a remote IDE.
