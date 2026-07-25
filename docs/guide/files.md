---
icon: lucide/folder-tree
---

# File browser (SFTP)

Every SSH tab can show the remote filesystem beside its terminal. The browser rides the
**session's existing SSH transport** — one SFTP channel per connection, shared by every
file operation — so there is no second connection and no second authentication.

<figure markdown="span">
  ![The file browser next to a terminal](../assets/screenshots/sftp.png#only-light){ .shadow }
  ![The file browser next to a terminal](../assets/screenshots/sftp-dark.png#only-dark){ .shadow }
  <figcaption>Open it with the folder button in the top bar; drag the divider to size it.</figcaption>
</figure>

## Navigating

- The path field is editable — type a path and press ++enter++.
- :material-arrow-up: goes to the parent, :material-home: to your remote home,
  :material-refresh: re-reads the directory.
- Double-click a directory to enter it; sort by name, size or modification time.
- **Open in new window** pops the browser out into its own window, still on the same
  connection.

## Transferring

| Gesture | What it does |
| --- | --- |
| **Drag files in** | Upload them to the current directory |
| **Drag a file out** | Download it to wherever you dropped it |
| :material-upload: | Upload with a file picker |
| :material-download: | Download the selected file |
| Double-click a file | Open it in the [remote editor](editor.md) |

Uploads and downloads show progress, and large transfers do not block the terminal in the
same tab.

!!! warning "Overwrites are never silent"

    Uploading onto an existing path asks first, naming the file it would replace.
    Nothing is overwritten until you confirm.

## Managing

The row menu (right-click) has **Open in editor**, **Download**, **Rename** and
**Delete**; the toolbar adds **New folder**. Deleting a directory removes its contents,
and is confirmed first.

## Under the hood

Uploads are written to a temporary name in the destination directory and then renamed into
place, so an interrupted transfer cannot leave a half-written file where the real one was.
Where the server supports it, the atomic `posix-rename` extension is used.

The SFTP channel belongs to the connection, not the panel: closing the browser leaves it
available for the [remote editor](editor.md), and closing the tab releases it with the
rest of the session's lease.
