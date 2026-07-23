# Muxus

Free, open-source SSH client & modern terminal — the MobaXterm workflow with a terminal that speaks the **kitty graphics protocol**.

- **Kitty graphics protocol** — `kitten icat`, yazi/ranger image previews, matplotlib backends and timg render inline images over SSH. Direct (chunked, optionally zlib-compressed) PNG/RGB/RGBA transmission, placements with z-index, cell sizing and delete commands; sixel and iTerm2 inline images work too.
- **Kitty keyboard protocol** — the progressive-enhancement flag stack (disambiguate, event types, alternate keys, report-all, associated text), so modern TUIs (neovim, helix, fish) get full key fidelity. `TERM=xterm-kitty` by default, honestly.
- **Session manager on ~/.ssh/config** — your OpenSSH config *is* the session store, nothing else. Every concrete `Host` block appears in the sidebar (grouped by Include file, with live-connection dots and jump/key/forward badges); adding or editing a session writes the block back in place without touching the rest of the file (atomic writes + `.muxus.bak`). The search box doubles as quick connect: type an alias or `user@host:port` and hit Enter.
- **Full connect-through** — ProxyJump chains (nested, comma-listed, cycle-checked) are dialed hop by hop like real ssh: every hop gets its own config resolution, host-key verification and authentication. Auth follows OpenSSH order inside one connection: agent → IdentityFile / default `id_*` keys (passphrase prompts included, `IdentitiesOnly` honored) → keyboard-interactive → password. `LocalForward`/`RemoteForward`/`DynamicForward` from the config start with the session; `ForwardAgent` works when an agent is present.
- **Host editor** — a MobaXterm-style visual editor for `Host` blocks: key picker fed by the keys found in `~/.ssh` (agent-loaded and encrypted keys badged), jump-chain builder, port-forwarding editor with a live tunnel diagram, free-form options for anything Muxus doesn't model, and an exact preview of the block text before it is written.
- **Tabbed terminals** — local shells (real PTYs) and SSH sessions side by side; browser-style tab strip, Ctrl+Tab cycling, Ctrl+Shift+T.
- **SFTP file browser** — per SSH tab, sharing the session's connection: navigate, upload (drag & drop), download, rename, delete, mkdir.
- **Port forwarding** — local (-L), remote (-R) and dynamic SOCKS5 (-D) forwards per connection, plus one click to save an ad-hoc forward into the host's config block.
- **Interactive auth done right** — keyboard-interactive/2FA prompts, key passphrases and password retries as dialogs (labelled with the hop that is asking); host keys are verified against the real `~/.ssh/known_hosts` (hashed entries included), trust-on-first-use appends to it, and a changed key gets the loud warning with `ssh-keygen -R`-style replacement on accept.
- Dark/light/system theme, frameless desktop window, Inter + JetBrains Mono.

## Architecture

pnpm workspace, all TypeScript/ESM:

| Package | What it is |
| --- | --- |
| `shared/` | REST DTOs + zod WebSocket protocol (`/ws/terminal`: binary frames = bytes, text frames = control) |
| `server/` | Fastify on 127.0.0.1 with per-run bearer token; ssh_config engine (line-preserving parser/resolver/editor), ssh2 connections with ProxyJump + OpenSSH-order auth, known_hosts verification, node-pty local shells, SFTP routes, forward manager |
| `client/` | React 19 + MUI, xterm.js with custom kitty graphics/keyboard engines (`client/src/terminal/`) |
| `electron/` | Desktop shell: embeds the server in-process, frameless window, state persistence over IPC |
| `tests/` | vitest units for the protocol parsers and encoders |

The kitty graphics protocol rides on APC escape sequences, which xterm.js has no hooks for — Muxus extracts them from the byte stream *before* `term.write()` (`apc-stream.ts`), anchors placements to xterm buffer markers so images scroll with text, and renders them into overlay layers (`kitty-graphics.ts`).

## Development

```sh
pnpm install
pnpm dev        # shared tsc --watch + server :3002 + Vite client :5174
```

Open http://localhost:5174. The dev server uses the fixed token `dev`; production runs mint a random per-run token and bind 127.0.0.1 only.

```sh
pnpm build      # build everything
pnpm start      # serve the built client from the server (opens browser)
pnpm electron   # desktop app (dev)
pnpm test       # unit tests
pnpm lint       # oxlint
pnpm typecheck
make deb|win|dmg|all   # installers via electron-builder
```

Note: the Electron desktop build rebuilds `node-pty` against Electron's ABI (`pnpm --filter @muxus/electron rebuild` for `pnpm electron` dev runs).

## Security model

Local single-user tool: the server binds 127.0.0.1 only, every request needs the per-run bearer token, WebSocket upgrades check token + Origin (DNS-rebinding defense). Passwords/passphrases are never stored — they travel only through the interactive auth prompts of a live connection. Host keys are verified against `~/.ssh/known_hosts` (and `/etc/ssh/ssh_known_hosts`, read-only) exactly like OpenSSH; first use appends there, and config edits are atomic with a `.muxus.bak` of the previous content.

## License

MIT
