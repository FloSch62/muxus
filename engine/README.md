# The Muxus SSH engine

A Node addon in Rust on [russh](https://github.com/Eugeny/russh). The server loads it through
`server/src/ssh/engine.ts`, which is the API the rest of Muxus uses.

The engine speaks the protocol and carries the bytes:

- the transport: TCP, a `ProxyCommand`, or a channel of another connection (jump hosts), with
  key exchange and encryption on its own threads
- the login, one step at a time: none, password, key file, certificate, keyboard-interactive,
  and identities whose private half signs elsewhere (an ssh-agent, a security key)
- channels: shells, commands, subsystems and tunnels, as streams
- SFTP, with handles kept as bytes and the reads and writes of a transfer sent ahead of their
  replies
- port forwards (local, dynamic SOCKS5, remote), agent forwarding and X11 connections, whose
  bytes never pass through JavaScript
- ssh-agent requests, each on a connection of its own

What to trust, which login method comes next and what the user is asked are not decided here.
Those stay in TypeScript, which answers the engine's callbacks (the host key) and calls its
login steps in the order `ssh` would.

## Building and testing

```bash
pnpm --filter @muxus/ssh-engine build   # release build for this computer
pnpm test:engine                        # the crate's own tests
pnpm lint:engine                        # cargo fmt and clippy
pnpm test:openssh                       # the whole connection stack against sshd in a container
```

The build writes `muxus-ssh-engine.<platform>.node` and `index.d.ts`. The typings are checked
in, so the TypeScript packages type-check without a Rust toolchain; CI fails when they are out
of date. `index.cjs` loads the binary for the computer it runs on.

`MUXUS_ENGINE_TARGETS` builds for other Rust targets instead, comma separated. The macOS
release sets it to both CPUs, because the universal app carries one binary for each.

## Errors

Failures reach JavaScript as `[CODE] message`, or `[CODE#detail] message` when a number
belongs to them (an SFTP status, the reason a channel was refused). `engine.ts` turns them
into `SshError`s with `code` and `detail`, so callers branch on codes, never on wording.

## One thing to know about flow control

russh grants the server more window as soon as data arrives, whether or not anyone has read
it. A channel whose reader stays behind is therefore slowed only by its queue filling up (4 MiB
per channel), after which the whole connection waits. For a terminal that is the renderer
catching up. For a tunnel it would be someone else's program that has stopped reading, so a
tunnel whose local end takes nothing for ten seconds is closed instead of holding up the other
channels of its connection.
