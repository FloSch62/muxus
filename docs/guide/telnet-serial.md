---
icon: lucide/cable
---

# Telnet & serial

Telnet and serial hosts appear in the same list as SSH hosts, with the same folders,
colours, search and workspaces. Typical targets are console servers, lab switches and
directly attached boards.

OpenSSH has no representation for these, so they are stored as Muxus's own saved hosts in
the local database rather than in `ssh_config`.

## Telnet

<figure markdown="span">
  ![The Telnet host editor](../assets/screenshots/telnet-editor.png#only-light){ .shadow }
  ![The Telnet host editor](../assets/screenshots/telnet-editor-dark.png#only-dark){ .shadow }
  <figcaption>The Telnet form takes a name, a host and a port.</figcaption>
</figure>

Sessions negotiate terminal type and window size, so full-screen tools on the far end
receive the pane dimensions and resize with it.

!!! danger "Telnet has no encryption and no server authentication"

    All traffic, including what is typed at a login prompt, crosses the network in the
    clear, and nothing proves the identity of the far end. Use it only on a trusted
    network: a console VLAN, a lab, or a direct cable.

## Serial

<figure markdown="span">
  ![The serial host editor](../assets/screenshots/serial-editor.png#only-light){ .shadow }
  ![The serial host editor](../assets/screenshots/serial-editor-dark.png#only-dark){ .shadow }
  <figcaption>Ports are discovered locally, and every line setting is configurable.</figcaption>
</figure>

Muxus discovers serial ports through the local backend on Linux, Windows and macOS, and
accepts a typed path when the device is not listed. Line settings are per profile:

| Setting | Values |
| --- | --- |
| **Baud rate** | 300 … 921 600, or a custom value |
| **Data bits** | 5, 6, 7, 8 |
| **Stop bits** | 1, 2 |
| **Parity** | none, even, odd, mark, space |
| **Flow control** | RTS/CTS, XON/XOFF, or none |

Platform naming:

=== ":material-linux: Linux"

    `/dev/ttyUSB0`, `/dev/ttyACM0`. Access usually requires membership in the
    distribution's serial group, `dialout` or `uucp`. Log out and back in after adding the
    membership.

=== ":material-apple: macOS"

    `/dev/tty.usbserial-*`, `/dev/tty.usbmodem*`.

=== ":material-microsoft-windows: Windows"

    `COM3`, `COM7`, …

!!! note "One reader per port"

    A serial port cannot be shared, so splitting a pane from a serial session always asks
    what to start rather than opening a second reader on the same device.

## Shared behaviour

Telnet and serial tabs behave as ordinary tabs. They live in panes, take colour flags, join
[multi-exec](commands.md#multi-execution) groups, are saved in [workspaces](workspaces.md),
and are recorded by [session history](session-history.md) when it is enabled. Features that
require SSH do not apply: no file browser, no remote editor, no port forwarding.
