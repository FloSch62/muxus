---
icon: lucide/file-pen
---

# Remote editor

Double-clicking a file in the [file browser](files.md) opens it in
[Monaco](https://microsoft.github.io/monaco-editor/), the editor used by VS Code. Reads and
writes go over the live SSH transport of that session.

<figure markdown="span">
  ![Editing a remote file with Monaco](../assets/screenshots/remote-editor.png#only-light){ .shadow }
  ![Editing a remote file with Monaco](../assets/screenshots/remote-editor-dark.png#only-dark){ .shadow }
  <figcaption>A remote file edited in place, without a sync folder or an scp round-trip.</figcaption>
</figure>

## Features

- Monaco's complete built-in syntax catalog, plus full language services for
  **JavaScript/TypeScript, JSON, HTML and CSS**: diagnostics, completion, hover and
  formatting.
- Folding, the minimap, sticky scroll, multi-cursor editing, find & replace, and Monaco's
  command palette (++f1++).
- Per-file undo history and view state, so switching between open files restores the
  previous position.
- Language mode, indentation and end-of-line sequence are switchable from the status bar.
- **Save** (++ctrl+s++) and **Save all**. Unsaved files are marked in the file list.

Several files stay open at once inside the tab, alongside the terminal.

## Conflict protection

Saving carries the modification time the file had when it was read. If the file changed on
the remote in the meantime, the save is refused and the editor offers **Reload from
remote**.

## Scope

The editor targets single-file edits: a config change, a compose file, a systemd unit. For
project-level work requiring a language server, a test runner or git history, use an
editor's own remote support. Muxus provides a file editor, not a remote IDE.
