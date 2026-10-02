---
icon: lucide/lock
---

# Privacy policy

*Last updated: October 2, 2026*

Muxus is a free, open-source SSH, Telnet, serial and remote-desktop client that runs
entirely on your computer. It has no accounts, no analytics and no telemetry, and the
developer receives no data from it.

## What Muxus stores

Everything Muxus keeps stays on your computer, in your user profile:

- **Connection settings**: hosts, folders, workspaces, tunnels and preferences in a local
  database. OpenSSH hosts stay in your own `~/.ssh/config`.
- **Trusted keys and certificates**: host keys you accept are added to
  `~/.ssh/known_hosts`; trusted RDP certificates and VNC server keys are pinned in the
  local database.
- **Saved passwords**, only if you create a password vault and choose **Remember this
  password**. They are encrypted, and the vault key is protected by your master password
  and the operating system's credential store (Windows Credential Manager, macOS Keychain
  or the Linux Secret Service).
- **Session history and logs**, only if you turn them on. They are kept in a folder you
  can choose and remove at any time.

Muxus reads the SSH configuration and key files you point it at in order to connect. It
does not upload them anywhere. Uninstalling Muxus and deleting its data folder removes
everything it stored; the [command-line reference](reference/cli.md) lists where that
folder is.

## Network connections

Muxus connects only where you tell it to: the SSH, Telnet, RDP and VNC servers, serial
devices, tunnels and X11 displays you open. That traffic goes directly between your
computer and those systems, never through a Muxus server.

The one request Muxus makes on its own is an update check. Installers downloaded from
GitHub read the latest release information from the Muxus repository on GitHub at
startup and every four hours. Linux `.deb` installs instead read a small `latest.json`
file from the Muxus documentation site, also hosted by GitHub, once at startup. The
request contains no personal information, and an update is downloaded from GitHub only
when you choose to. Turning off **Notify me when a new version is available** under
**Settings → About** stops the background checks. As with any website, GitHub may record
the request's IP address under the
[GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

The Microsoft Store version asks the Microsoft Store whether an update is available, and
the Store downloads and installs it when you choose **Update now**. This is handled by
Windows under [Microsoft's privacy statement](https://privacy.microsoft.com/privacystatement).

## What Muxus does not do

- It does not collect usage data, crash reports or personal information.
- It does not show ads or include third-party tracking code.
- It does not sell or share data, because it has none to share.
- It does not send passwords, keys or session content anywhere except to the system you
  are connecting to.

The [security model](reference/security.md) describes how stored data is protected in
detail.

## Children

Muxus is a developer tool and does not knowingly collect information from anyone,
including children.

## Changes and contact

Changes to this policy are published on this page with a new date. Questions can be
asked through [GitHub issues](https://github.com/FloSch62/muxus/issues); security
issues can be reported privately through the
[repository's security advisories](https://github.com/FloSch62/muxus/security/advisories).
