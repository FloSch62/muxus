---
icon: lucide/arrow-left-right
---

# Tunnels & port forwarding

Muxus treats a port forward as something you *keep*, not something you re-type. The
forwarding panel — the :material-swap-horizontal: button in the top bar, badged with the
number of active forwards — has two halves: **persistent tunnels** you saved, and the
forwards running on each **live connection**.

<figure markdown="span">
  ![The forwarding panel](../assets/screenshots/tunnels.png#only-light){ .shadow }
  ![The forwarding panel](../assets/screenshots/tunnels-dark.png#only-dark){ .shadow }
  <figcaption>Saved tunnels start with one click; session forwards show where they came from.</figcaption>
</figure>

## Persistent tunnels

A saved tunnel is a name, a target host and a rule. Start it with :material-play: and it
runs **without a terminal**: Muxus reuses a live connection to that host if there is one,
or dials a shell-less transport (`ssh -N` in spirit) with the full interactive
authentication flow — host-key check, key passphrase, 2FA prompt, all of it.

| Type | Flag | What it does |
| --- | --- | --- |
| Local | `-L` | A port on your machine reaches a host and port on the far side |
| Remote | `-R` | A port on the remote reaches something on your side |
| Dynamic | `-D` | A local SOCKS5 proxy through the remote |

Tunnels hold their own **transport lease**, which is the important part: closing every
terminal to that host does not tear the tunnel down. Stop it when you mean to stop it.

## Forwards on a live connection

The lower half lists each connected host and the forwards running on it:

- **`config`-badged** forwards come from the host's `LocalForward` / `RemoteForward` /
  `DynamicForward` lines. They start with the session and stop with it. Stopping one by
  hand only affects this session — the config rule stays.
- **Ad-hoc** forwards are the ones you started here with **+**. Two buttons turn them into
  something durable:
    - :material-content-save: **Save as tunnel** — it moves into the persistent list, so you
      can start it later without a terminal;
    - :material-bookmark-plus: **Save to ssh config** — it is written into that host's
      `Host` block, so *every* future connection starts it, including from `ssh` on the
      command line.

## Adding a forward

From **+ Tunnel** in the panel header, or **+** on a live connection. Either way you fill
in the same three things — bind port, target host, target port — and the
[host editor's](adding-hosts.md#port-forwarding) live diagram makes the direction obvious.

!!! tip "Which one should I use?"

    - Need it *while you work on that box*? Declare it on the host, so it comes up with
      the session.
    - Need it *whether or not you are on that box* — a database GUI, a browser pointed at
      an internal dashboard? Save it as a tunnel.

## Reaching a tunnel

Bindings are on `127.0.0.1`. A local forward on port 3000 is `http://127.0.0.1:3000`; a
dynamic forward on 1080 is a SOCKS5 proxy at `127.0.0.1:1080` — point your browser's proxy
settings or `curl --socks5-hostname` at it.

Every tunnel is reachable from the [quick launcher](quick-launcher.md) too: ++ctrl+k++,
type its name, and it starts or stops in place.
