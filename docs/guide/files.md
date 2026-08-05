---
icon: lucide/folder-tree
---

# File browser (SFTP)

Every SSH tab can display the remote filesystem beside its terminal. The browser uses the
session's existing SSH transport, with one SFTP channel per connection shared by every file
operation, so no second connection or authentication is required.

<figure markdown="span">
  ![The file browser next to a terminal](../assets/screenshots/sftp.png#only-light){ .shadow }
  ![The file browser next to a terminal](../assets/screenshots/sftp-dark.png#only-dark){ .shadow }
  <figcaption>The browser is opened with the folder button in the top bar and sized by dragging the divider.</figcaption>
</figure>

## Navigating

- The path field is editable. Enter a path and press ++enter++.
- :material-arrow-up: goes to the parent directory, :material-home: to the remote home
  directory, and :material-refresh: re-reads the current directory.
- Double-click a directory to enter it. Sorting is by name, size or modification time.
- **Follow terminal folder** is enabled by default. The browser opens at the shell's current
  directory and follows later `cd` commands; clear it to browse independently.
- **Open in new window** moves the browser into its own window on the same connection.

## Transferring

| Gesture | What it does |
| --- | --- |
| **Drag files in** | Upload them to the current directory |
| **Drag a file out** | Download it to the drop location |
| :material-upload: | Upload with a file picker |
| :material-download: | Download the selected file |
| Double-click a file | Open it in the [remote editor](editor.md) |

Uploads and downloads report progress, and large transfers do not block the terminal in the
same tab.

!!! warning "Overwrite confirmation"

    Uploading onto an existing path asks for confirmation and names the file it would
    replace.

## Managing

The row menu, opened with right-click, has **Open in editor**, **Download**, **Rename** and
**Delete**. The toolbar adds **New folder**. Deleting a directory removes its contents and
is confirmed first.

## Transfer safety

Uploads are written to a temporary name in the destination directory and then renamed into
place, so an interrupted transfer cannot leave a partially written file at the destination
path. Where the server supports it, the atomic `posix-rename` extension is used.

The SFTP channel belongs to the connection rather than the panel. Closing the browser
leaves it available for the [remote editor](editor.md), and closing the tab releases it
with the rest of the session's lease.
