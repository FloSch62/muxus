# Muxus

Free, open-source SSH, Telnet, and serial client with a modern terminal — the MobaXterm workflow with a terminal that speaks the **kitty graphics protocol**.

- **Kitty graphics protocol** — `kitten icat`, yazi/ranger image previews, matplotlib backends and timg render inline images over SSH. Direct (chunked, optionally zlib-compressed) PNG/RGB/RGBA transmission, placements with z-index, cell sizing and delete commands; sixel and iTerm2 inline images work too.
- **Kitty keyboard protocol** — the progressive-enhancement flag stack (disambiguate, event types, alternate keys, report-all, associated text), so modern TUIs (neovim, helix, fish) get full key fidelity. Sessions advertise the broadly supported `TERM=xterm-256color`.
- **OpenSSH-native connections, Muxus-owned metadata** — every concrete `Host` block appears in the sidebar (grouped by Include file, with favorites, recent-use metadata, live-connection dots and jump/key/forward badges). Connection details stay interoperable in OpenSSH config; Muxus stores UI metadata and recoverable workspaces in a versioned local SQLite database. Adding or editing a session writes its block back in place without touching the rest of the file (atomic writes + `.muxus.bak`). The search box doubles as quick connect: type an alias or `user@host:port` and hit Enter.
- **Telnet and serial hosts** — save Telnet endpoints and COM/TTY consoles alongside SSH hosts, then search, favorite, group, color, edit, duplicate, or reconnect them through the same host workflow. Telnet sessions negotiate terminal type and window size. Serial ports are discovered through the local backend on Linux, Windows, and macOS, with manual path entry plus configurable baud rate, data bits, stop bits, parity, and RTS/CTS or XON/XOFF flow control.
- **Full connect-through** — ProxyJump chains (nested, comma-listed, cycle-checked) are dialed hop by hop like real ssh: every hop gets its own config resolution, host-key verification and authentication. Auth follows OpenSSH order inside one connection: agent → IdentityFile / default `id_*` keys (passphrase prompts included, `IdentitiesOnly` honored) → keyboard-interactive → password. `LocalForward`/`RemoteForward`/`DynamicForward` from the config start with the session; `ForwardAgent` works when an agent is present.
- **Host editor** — one add-host flow for SSH, Telnet, and serial. The MobaXterm-style SSH editor includes a key picker fed by `~/.ssh`, a jump-chain builder, port-forwarding with a live tunnel diagram, free-form options, and an exact block preview; Telnet and serial use native saved profiles in Muxus.
- **Split terminal workspaces** — local shells (real PTYs), SSH, Telnet, and serial sessions in resizable horizontal/vertical panes, each with its own browser-style tab strip. Pane geometry and tab definitions survive restart; restored local tabs automatically start fresh shells, while remote sessions stay disconnected until you explicitly reconnect.
- **Terminal quality of life** — one-click saved command buttons (run immediately or insert for review), incremental scrollback search (case / whole-word / regex), export the buffer as text or color-preserving HTML, copy-all, clear-scrollback, select-all, per-tab zoom (Ctrl+wheel or keyboard), a configurable right-click (copy/paste convention, always-paste, or context menu), and a confirmation preview before multiline text can execute several shell commands. Tabs rename (double-click), duplicate and take color flags.
- **Persistent session history** — opt-in logging retains terminal bytes independently of finite live scrollback without bloating the application database. A dedicated worker writes framed raw events to rotated zstd segments and batches normalized transcript chunks into a separate FTS5 history database. Fresh installs keep logging off and apply a hard 5 GiB global quota, a 2 GiB-or-5% free-space reserve, and 10 × 5 MiB per-session parts. Oldest unpinned completed sessions are evicted to an 85% low-water mark; active sessions are never removed, and exhausted storage suspends logging without interrupting the terminal. Settings expose usage, quota, optional age retention, pinning, and a configurable history location. The history dialog uses debounced, cursor-paged search with host/date/connection filters and exports either lossless base64 NDJSON (`.muxlog`) or a self-contained, seekable HTML replay.
- **Live settings** — a sectioned settings dialog (appearance, terminal, highlighting, behavior, shortcuts) whose changes apply immediately to open terminals: terminal color schemes (Muxus, Dracula, One Dark, Nord, Gruvbox, Catppuccin, Monokai, Solarized), global keyword highlighting with host-specific additive/replacement rules, font family/size/line height, cursor, scrollback and clipboard behavior.
- **SFTP file browser** — per SSH tab, sharing the underlying SSH transport: navigate, upload (drag & drop), download, rename, delete and mkdir. Existing upload targets require an explicit overwrite confirmation.
- **Remote code editor** — multi-file Monaco editing over the live SSH transport with Monaco's complete built-in syntax catalog, JS/TS + JSON/HTML/CSS language services, diagnostics, completion, hover, formatting, folding, minimap and sticky scroll, command palette, find/replace, multi-cursor editing, language/indentation/EOL controls, per-file undo/view state, save-all and remote-change conflict protection.
- **Tunnel manager** — the MobaXterm workflow: saved tunnels (local -L, remote -R, dynamic SOCKS5 -D) live in a dedicated forwarding panel and start/stop with one click, no terminal needed — starting one reuses a live connection to the target or dials a shell-less transport (`ssh -N` style) with the full interactive-auth flow. Independent transport leases mean closing a terminal never tears down a running tunnel. Ad-hoc forwards on live connections can be promoted to saved tunnels or written into the host's config block.
- **Interactive auth done right** — keyboard-interactive/2FA prompts, key passphrases and password retries as dialogs (labelled with the hop that is asking); host keys are verified against the real `~/.ssh/known_hosts` (hashed entries included), trust-on-first-use appends to it, and a changed key gets the loud warning with `ssh-keygen -R`-style replacement on accept.
- Dark/light/system theme, frameless desktop window, Inter + JetBrains Mono with bundled Nerd Font/Powerline glyph coverage for remote prompts and TUIs.

## Architecture

pnpm workspace, all TypeScript/ESM:

| Package | What it is |
| --- | --- |
| `shared/` | REST DTOs + zod WebSocket protocol (`/ws/terminal`: binary frames = bytes, text frames = control) |
| `server/` | Fastify on 127.0.0.1 with per-run bearer token; a small versioned application SQLite database plus worker-owned hybrid session history (FTS5 metadata + compressed segment files + disk quota/recovery); ssh_config engine (line-preserving parser/resolver/editor); leased ssh2 transports with ProxyJump + OpenSSH-order auth; known_hosts verification; node-pty local shells; Telnet negotiation; cross-platform node-serialport access; SFTP routes and forward manager |
| `client/` | React 19 + MUI, resizable pane tree and workspace recovery, xterm.js Image Addon for graphics plus native Kitty keyboard support |
| `electron/` | Hardened desktop shell: embeds the server in-process, uses an isolated preload bridge for bootstrap credentials and blocks unexpected navigation |
| `tests/` | vitest units for security/auth boundaries, persistence and migrations, connection leases, workspace/pane behavior, SFTP overwrite policy, paste safety, and terminal protocols |

Kitty graphics APC sequences flow directly into xterm.js 6.1 and its Image Addon. The addon parses chunked payloads incrementally, streams base64 decoding through WebAssembly, and renders images as terminal-buffer-aware canvas layers without a second parser or per-chunk scheduling queue in Muxus.

## Development

```sh
pnpm install
pnpm dev        # shared tsc --watch + server :3002 + Vite client :5174
```

Open http://localhost:5174. The dev server uses the fixed token `dev`; production runs mint a random per-run token, keep it out of request URLs, and bind 127.0.0.1 only.

```sh
pnpm build      # build everything
pnpm start      # serve the built client from the server (opens browser)
pnpm electron   # desktop app (dev)
pnpm test       # unit tests
pnpm lint       # oxlint
pnpm typecheck
make deb|win|dmg|all   # installers via electron-builder
```

Note: the Electron desktop build rebuilds the native `node-pty` and `serialport`
bindings against Electron's ABI (`pnpm --filter @muxus/electron rebuild` for
`pnpm electron` dev runs).

On Linux, serial devices commonly require membership in the distribution's
serial-access group (often `dialout` or `uucp`). Log out and back in after a
group-membership change. Windows uses names such as `COM3`; macOS and Linux
use `/dev/tty.*` and `/dev/ttyUSB*`/`/dev/ttyACM*` paths respectively.

CI runs typecheck, lint and tests, then builds unpacked desktop packages on Linux, macOS and Windows.

## Security model

Local single-user tool: the server binds 127.0.0.1 only, every API request needs the per-run bearer token, and WebSocket upgrades check both token and Origin (DNS-rebinding defense). Bootstrap credentials stay out of request URLs: browsers receive them in a fragment that is immediately removed, Electron uses an isolated preload bridge, and terminal sockets authenticate with a WebSocket subprotocol. Passwords/passphrases remain transient interactive-auth data; the SQLite persistence boundary rejects password, passphrase, secret, token and private-key material, so persisted credential fields are references only. Session logging is opt-in. When enabled, remote output is recorded but the separate client-input stream remains suppressed unless input capture is explicitly enabled; echoed commands are still remote output, so pause logging before displaying secrets. Host keys are verified against `~/.ssh/known_hosts` (and `/etc/ssh/ssh_known_hosts`, read-only) exactly like OpenSSH; first use appends there, and config edits are atomic with a `.muxus.bak` of the previous content. Telnet itself provides no encryption or server authentication; use it only on a trusted network.

## License

MIT
