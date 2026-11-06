---
icon: lucide/square-terminal
---

# Windows shells (WinRM)

A **WinRM** host opens a command shell on a Windows machine through Windows Remote
Management, the way `winrs -r:server cmd` does. Nothing needs to be installed on either
side beyond what Windows already has: WinRM is on by default on Windows Server, and
`winrm quickconfig` turns it on elsewhere.

## Adding a host

**Add host → WinRM** asks for:

| Field | |
|---|---|
| **Host** and **Port** | 5985 for HTTP, 5986 for HTTPS when the port is left empty |
| **HTTPS** | Off is plain HTTP, the Windows default. NTLM still encrypts every message, so nothing crosses the network in the clear. |
| **Do not check the certificate** | For HTTPS with a self-signed certificate |
| **Shell** | Command Prompt (`cmd.exe`) or Windows PowerShell |
| **User name** | `DOMAIN\user`, `user@domain`, or a local account. Empty asks when connecting. |
| **Authentication** | Negotiate (NTLM), or Basic over HTTPS only |
| **Connection route** | An optional SSH gateway, with fallback gateways tried in order |

WinRM hosts are stored as Muxus's own saved hosts, not in `ssh_config`.

## Signing in

Muxus asks for the password when it connects. Tick **Remember this password** there to keep
it in the encrypted password vault, as with SSH and RDP passwords. A rejected password asks
again.

Domains that have turned NTLM off and allow only Kerberos cannot sign in this way yet.

## In the tab

WinRM gives the remote shell plain pipes rather than a console, so Muxus edits the line
the way `winrs` does:

- What you type is shown and edited locally and sent when you press ++enter++.
- ++backspace++, ++ctrl+u++ (clear the line) and ++ctrl+w++ (delete a word) edit it.
- ++up++ and ++down++ go through the lines you sent.
- ++ctrl+c++ interrupts the running command; **Send BREAK** sends Ctrl+Break.
- Programs that draw full-screen (editors, `more` paging) or read single keys do not work
  over pipes. Tab completion is not available.

Typing `exit` ends the shell and closes the session. Sessions are recorded in
[session history](session-history.md) like other terminal sessions.
