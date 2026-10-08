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

## Docking it in the sidebar

By default the browser opens beside the terminal, separately for each SSH tab. It can live
in the sidebar instead, one browser for the whole window that shows the files of whichever
SSH session is active:

- Click **Move to the sidebar** in the browser's header, or choose **Sidebar** for **File
  browser** under **Settings → Appearance → Layout**.
- The sidebar gains vertical tabs along the window edge: **Hosts** and **File browser**.
  Click one, or use the arrow keys once a tab has focus. The folder button in the top bar
  switches to the file browser and back.
- Switching to another SSH tab shows that session's files. A local, Telnet, serial or remote
  desktop tab has none, and the browser says so.
- The browser stays where it was while the hosts are in front, so an upload keeps running
  and the folder is unchanged when you switch back.
- **Move beside the terminal** in the header puts it back next to the terminal.

In a narrow sidebar the **Modified** column and the drag hint are hidden; widen the sidebar
by dragging its edge to bring them back.

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

The row menu, opened with right-click, has **Open in editor**, **Open with default
program**, **Open with…**, **Download**, **Rename** and **Delete**. The toolbar adds **New
folder**. Deleting a directory removes its contents and is confirmed first.

## Opening files with local programs

In the desktop app, a file can be opened with a program on your computer without
downloading it by hand first: an HTML page in the browser, an image in a viewer, a
`.drawio` diagram in draw.io.

- **Open with default program** uses the program your system opens that type of file with.
- **Open with…** lets you choose. Windows shows its own *How do you want to open this
  file?* dialog, and macOS asks for an application. On Linux, Muxus lists the installed
  programs, with those that handle the file's type at the top; **Browse…** picks any other
  program, such as an AppImage.

The file is downloaded with the usual progress bar into a private folder of its own, then
handed to the program. On Linux these copies are kept under `.muxus-open` in your Downloads
folder, where sandboxed snap applications can read them; on Windows and macOS they are kept
in the temporary folder. On Windows, the copy carries the same downloaded-from-the-internet
mark as a browser download. Copies untouched for a day are removed the next time Muxus
starts or opens a file.

### Uploading your changes

When the program saves the file, Muxus asks **Upload changes to *file*?** and uploads it
back to the same path, with a progress card in the bottom-left corner of the window. Tick
**Upload later changes to this file without asking** to have later saves uploaded straight
away. Saves that leave the contents unchanged are not offered.

If the file on the server changed after you opened it, Muxus does not overwrite it
silently: it asks before replacing that version with yours. The upload needs the session
that opened the file; once that connection has closed, Muxus tells you where your copy is
so you can upload it by hand.

## Transfer safety

Uploads are written to a temporary name in the destination directory and then renamed into
place, so an interrupted transfer cannot leave a partially written file at the destination
path. Where the server supports it, the atomic `posix-rename` extension is used.

The SFTP channel belongs to the connection rather than the panel. Closing the browser
leaves it available for the [remote editor](editor.md), and closing the tab releases it
with the rest of the session's lease.
