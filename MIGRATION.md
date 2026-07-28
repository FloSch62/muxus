# Electron → Go + Wails migration

## Goal

Replace the Electron desktop shell and the Node server with a **single Go
binary** wrapped in **Wails v3** (system webviews: WebView2 / WKWebView /
WebKitGTK), cutting installs from ~100 MB+ to a target of ≤ 30 MB — while the
web client (React + MUI + xterm.js) stays pixel-identical and browser mode
(`muxus serve`) remains first-class. Hard cutover on `feat/go-wails`:
`server/` and `electron/` are deleted once the Go implementation reaches
feature parity; `client/` and `shared/` stay.

Key decisions:

- Keep the current architecture inside the desktop app: local HTTP server on
  `127.0.0.1:<random port>`, per-run bearer token, webview loads that origin.
  The Wails runtime mounts into the muxus router at `/wails/runtime`
  (`Options.Transport`); the client bundles `@wailsio/runtime` in shell mode.
- Wire contract = `shared/src/api-types.ts` + `shared/src/ws-protocol.ts`.
  Shared fixtures in `tests/contract/` are validated by both the zod schemas
  (vitest) and the Go mirrors (`app/internal/api`) so the implementations
  cannot drift apart.
- Existing user data is honored byte-for-byte: same SQLite schema and
  migrations, same data directories (including Electron's Linux
  `~/.config/Muxus` vs serve-mode XDG data-home split), same
  `client-state.json` / `window-state.json`.
- Linux builds use `-tags gtk3` (webkit2gtk-4.1) for distro reach.

## Status

| Milestone | State | Notes |
|---|---|---|
| M0 — Wails v3 spike | **done** | All gated APIs verified on alpha2.119; findings in `app/SPIKE-FINDINGS.md` |
| M1 — Server skeleton + persistence | **done** | Router/auth/CSP byte-identical; all 39 DB methods + 10 migrations ported; bidirectional Node↔Go DB compatibility test passes |
| M2 — Terminal core | **done** | `/ws/terminal`, local PTY (ConPTY-capable), full telnet negotiation, serial; real client verified end-to-end in a browser against the Go server |
| M3 — SSH stack | **done** | Connection multiplexing and keepalives; ProxyJump/ProxyCommand; OpenSSH-order authentication, certificates and agent forwarding; known_hosts; SSH/SFTP routes and lease socket; -L/-R/-D forwards with SOCKS5; saved tunnels |
| M4 — History + remaining routes | **done** | Dedicated history worker, rotated zstd raw segments, FTS5 transcript search, privacy-aware recorder, retention/recovery/import, all history routes; workspaces, snapshots, profiles and host ordering |
| M5 — Wails shell | **done** | Random-port authenticated server, `/wails/runtime`, primary/secondary windows, state compatibility, macOS menu plus cross-platform chords/dialogs, single-instance focus and ordered shutdown |
| M6 — Client adapter | **done** | Pre-hydration Wails adapter, runtime bundle, native window controls, titlebar drag regions and secondary-window launch payloads; browser mode remains unchanged |
| M7 — Cutover + release | **done** | `server/` and `electron/` removed; compressed client embedded in the Go executable; Linux `gtk3` build and `.deb`; three-platform CI/release archives; 30,000,000-byte build gate |

## Result

The Linux x64 production executable is **23,321,312 bytes** with the complete
client embedded. Its release tarball is about 13 MB. `muxus` launches Wails;
`muxus serve` runs the same router and client in a regular browser.
