---
icon: lucide/cable
---

# Telnet & serial

Not everything speaks SSH. Console servers, switches in a lab, a board on the desk with a
USB adapter — Muxus keeps those in the same list, with the same folders, colours, search
and workspaces as your SSH hosts.

Because OpenSSH has nowhere to put them, these are **Muxus's own saved hosts**, stored in
the local database rather than in `ssh_config`.

## Telnet

<figure markdown="span">
  ![The Telnet host editor](../assets/screenshots/telnet-editor.png#only-light){ .shadow }
  ![The Telnet host editor](../assets/screenshots/telnet-editor-dark.png#only-dark){ .shadow }
  <figcaption>A name, a host and a port, in the same editor shell as the SSH form — plus the warning Telnet has earned.</figcaption>
</figure>

Sessions negotiate terminal type and window size, so full-screen tools on the far end know
how big your pane is and resize with it.

!!! danger "Telnet has no encryption and no server authentication"

    Everything, including whatever you type at a login prompt, crosses the network in the
    clear, and nothing proves the far end is who it claims to be. Use it only on a network
    you trust — a console VLAN, a lab, a direct cable.

## Serial

<figure markdown="span">
  ![The serial host editor](../assets/screenshots/serial-editor.png#only-light){ .shadow }
  ![The serial host editor](../assets/screenshots/serial-editor-dark.png#only-dark){ .shadow }
  <figcaption>Ports are discovered locally, and every line setting is there for when 115200 8N1 is not what the device wants.</figcaption>
</figure>

Muxus discovers serial ports through the local backend on Linux, Windows and macOS, and
lets you type a path when the device is not in the list. Per-profile line settings:

| Setting | Values |
| --- | --- |
| **Baud rate** | 300 … 921 600, or your own |
| **Data bits** | 5, 6, 7, 8 |
| **Stop bits** | 1, 2 |
| **Parity** | none, even, odd, mark, space |
| **Flow control** | RTS/CTS, XON/XOFF, or none |

Platform naming:

=== ":material-linux: Linux"

    `/dev/ttyUSB0`, `/dev/ttyACM0`. Access usually requires membership in the
    distribution's serial group (`dialout` or `uucp`) — log out and back in after adding
    yourself.

=== ":material-apple: macOS"

    `/dev/tty.usbserial-*`, `/dev/tty.usbmodem*`.

=== ":material-microsoft-windows: Windows"

    `COM3`, `COM7`, …

!!! note "One reader per port"

    A serial port cannot be shared, so splitting a pane from a serial session always asks
    what to start rather than opening a second reader on the same device.

## Everything else still applies

Telnet and serial tabs are ordinary tabs: they live in panes, take colour flags, join
[multi-exec](commands.md#multi-execution) groups, are saved in
[workspaces](workspaces.md), and are recorded by
[session history](session-history.md) when you enable it. What they do not get is anything
that needs SSH — no file browser, no remote editor, no port forwarding.
