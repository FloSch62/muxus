---
icon: lucide/folder-symlink
---

# File shares (SMB & NFS)

**SMB** (Windows file sharing, Samba) and **NFS** shares can be saved in the host list with
your other hosts. Opening one mounts it with your operating system's own client and shows it
in Finder or Explorer; Muxus does not copy files itself.

## Adding a share

**Add host → SMB** or **Add host → NFS**. Pasting `\\server\share\folder`,
`smb://server/share` or `server:/export` into **Server** fills the fields for you.

| SMB | |
|---|---|
| **Server**, **Port** | Port 445 when empty |
| **Share** and **Folder** | The share name, and optionally a folder inside it to open |
| **User name** | `DOMAIN\user` or `user@domain`. Empty mounts as guest, or on Windows as you |

| NFS | |
|---|---|
| **Server**, **Export path** | For example `nas.lab` and `/srv/data` |
| **Version** | NFSv4 (default) or NFSv3 |
| **Read only** | Mount without write access |

## Opening and unmounting

Opening a share (double-click, **Connect**, or the quick launcher) mounts it and opens it in
the file manager. A share that is already mounted just opens. **Unmount share** in the host's
right-click menu unmounts it.

| | SMB | NFS |
|---|---|---|
| macOS | `mount_smbfs`, under `~/Muxus Shares` | `mount_nfs`, under `~/Muxus Shares` |
| Linux | `gio mount` (GVFS), no root needed | `mount`: needs root, or an `/etc/fstab` line with the `user` option |
| Windows | `net use` | `mount.exe`, with **Client for NFS** turned on in Windows Features |

Mounts stay after Muxus quits, the way Finder's do.

## Passwords

For an SMB share with a user name, Muxus asks for the password when it mounts and types it
into the mount tool's own prompt, so it never appears on a command line or in the process
list. Tick **Remember this password** to keep it in the password vault (the vault must be
set up and unlocked). A rejected password asks again.

NFS has no password: the server decides what you may do from your computer's address and
your user ID.

## Through an SSH gateway

**Connection route → SSH gateway** reaches a share behind a bastion. Muxus forwards a local
port to the share through the gateway and mounts that; the forward stops when the share is
unmounted. Fallback gateways are tried in order.

- SMB works through a gateway on macOS and Linux. Windows can only reach SMB on port 445 of
  the server itself, so a gateway cannot be used there.
- NFS needs NFSv4, which uses a single port. NFSv3 also needs the portmapper and mountd, so
  it cannot go through a gateway.
