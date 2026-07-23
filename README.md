# Muxus

Free, open-source SSH client & modern terminal — the MobaXterm workflow with a terminal that speaks the **kitty graphics protocol**.

- **Kitty graphics protocol** — `kitten icat`, yazi/ranger image previews, matplotlib backends and timg render inline images over SSH. Direct (chunked, optionally zlib-compressed) PNG/RGB/RGBA transmission, placements with z-index, cell sizing and delete commands; sixel and iTerm2 inline images work too.
- **Kitty keyboard protocol** — the progressive-enhancement flag stack (disambiguate, event types, alternate keys, report-all, associated text), so modern TUIs (neovim, helix, fish) get full key fidelity. `TERM=xterm-kitty` by default, honestly.
- **Session manager** — saved SSH sessions (agent / key / password auth, groups) plus your parsed `~/.ssh/config` hosts, one click to connect.
- **Tabbed terminals** — local shells (real PTYs) and SSH sessions side by side; browser-style tab strip, Ctrl+Tab cycling, Ctrl+Shift+T.
- **SFTP file browser** — per SSH tab, sharing the session's connection: navigate, upload (drag & drop), download, rename, delete, mkdir.
- **Port forwarding** — local (-L), remote (-R) and dynamic SOCKS5 (-D) forwards per connection.
- **Interactive auth done right** — keyboard-interactive/2FA prompts, key passphrases and password retries as dialogs; trust-on-first-use host key verification with a loud key-changed warning.
- Dark/light/system theme, frameless desktop window, Inter + JetBrains Mono.

## Architecture

pnpm workspace, all TypeScript/ESM:

| Package | What it is |
| --- | --- |
| `shared/` | REST DTOs + zod WebSocket protocol (`/ws/terminal`: binary frames = bytes, text frames = control) |
| `server/` | Fastify on 127.0.0.1 with per-run bearer token; ssh2 connections, node-pty local shells, SFTP routes, forward manager |
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

Local single-user tool: the server binds 127.0.0.1 only, every request needs the per-run bearer token, WebSocket upgrades check token + Origin (DNS-rebinding defense). Passwords/passphrases are never stored — they travel only through the interactive auth prompts of a live connection. Host keys are pinned on first use in `~/.config/muxus/known-hosts.json`.

## License

MIT
