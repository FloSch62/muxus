---
icon: lucide/arrow-left-right
---

# Tunnels & port forwarding

The forwarding panel is the :material-swap-horizontal: control in the top bar, badged with
the number of active forwards. It has two sections: **persistent tunnels** that have been
saved, and the forwards running on each **live connection**.

<figure markdown="span">
  ![The forwarding panel](../assets/screenshots/tunnels.png#only-light){ .shadow }
  ![The forwarding panel](../assets/screenshots/tunnels-dark.png#only-dark){ .shadow }
  <figcaption>Saved tunnels in the upper section, per-connection forwards in the lower one.</figcaption>
</figure>

## Persistent tunnels

A saved tunnel consists of a name, a target host and a rule. Starting it with
:material-play: runs it without a terminal. Muxus reuses a live connection to that host if
one exists, or dials a shell-less transport with the full interactive authentication flow:
host-key check, key passphrase and 2FA prompt.

| Type | Flag | What it does |
| --- | --- | --- |
| Local | `-L` | A port on the local machine reaches a host and port on the far side |
| Remote | `-R` | A port on the remote reaches a local target |
| Dynamic | `-D` | A local SOCKS5 proxy through the remote |

Tunnels hold their own transport lease, so closing every terminal to that host does not
stop the tunnel.

## Forwards on a live connection

The lower section lists each connected host and the forwards running on it:

- **`config`-badged** forwards come from the host's `LocalForward`, `RemoteForward` or
  `DynamicForward` lines. They start and stop with the session. Stopping one manually
  affects only the current session; the configuration rule is unchanged.
- **Ad-hoc** forwards are those started from the panel with **+**. Two actions make them
  durable:
    - :material-content-save: **Save as tunnel** moves it into the persistent list, so it
      can be started later without a terminal;
    - :material-bookmark-plus: **Save to ssh config** writes it into that host's `Host`
      block, so every future connection starts it, including from `ssh` on the command
      line.

## Adding a forward

Use **+ Tunnel** in the panel header, or **+** on a live connection. Both require a bind
port, a target host and a target port, and the
[host editor's](adding-hosts.md#port-forwarding) diagram shows the resulting direction.

!!! tip "Choosing between the two"

    - A forward needed while working on that host belongs on the host, so it starts with
      the session.
    - A forward needed independently of a terminal session, such as one used by a database
      GUI or a browser, belongs in the persistent tunnel list.

## Reaching a tunnel

Bindings are on `127.0.0.1`. A local forward on port 3000 is reachable at
`http://127.0.0.1:3000`. A dynamic forward on 1080 is a SOCKS5 proxy at `127.0.0.1:1080`,
usable from a browser's proxy settings or `curl --socks5-hostname`.

Tunnels are also reachable from the [quick launcher](quick-launcher.md): press ++ctrl+k++,
type the name, and the tunnel starts or stops in place.
