---
icon: lucide/file-pen
---

# File editor

Click an underlined file path in a local or SSH terminal to open it in
[Monaco](https://microsoft.github.io/monaco-editor/), the editor used by VS Code. Files in
SSH sessions use that session's live SFTP transport; files in local terminals are read and
saved directly on the machine running Muxus. Double-clicking a file in the
[file browser](files.md) opens the same editor.

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

Saving carries the modification time the file had when it was read. If it changes on disk
or on the remote host in the meantime, the save is refused and the editor offers to reload
the newer version.

## Scope

The editor targets single-file edits: a config change, a compose file, a systemd unit. For
project-level work requiring a language server, a test runner or git history, use an
editor's own project support. Muxus provides a file editor, not a full IDE.
