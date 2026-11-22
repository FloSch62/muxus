---
icon: lucide/hammer
---

# Building from source

## Requirements

- **Node.js ≥ 24.17** (CI builds on 24.18)
- **pnpm**, with the version pinned in `package.json` through `packageManager`
- A C/C++ toolchain for the two native modules (`node-pty`, `serialport`)
- **Rust**, through [rustup](https://rustup.rs), for the SSH engine in `engine/` (and
  [NASM](https://www.nasm.us) on Windows)
- **Docker**, only for `pnpm test:openssh`

## Setup

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm dev
```

`pnpm dev` builds the SSH engine if it has changed, then runs three processes in parallel:
`shared` in `tsc --watch`, the server on **:3002**, and the Vite client on **:5174**. Open
<http://localhost:5174>.

In dev the API token is the fixed string `dev`, because the Vite client cannot learn a
random one at startup. The server still binds loopback only.

## Project layout

```text
shared/     REST DTOs + the zod WebSocket protocol
server/     Fastify server: ssh_config engine, leases, SFTP, forwards, history
client/     React 19 + MUI, pane canvas, keymap, xterm.js
electron/   Desktop shell (embeds the server in-process)
tests/      vitest units
hack/       Documentation sandbox and screenshot capture
```

[The architecture in more detail :octicons-arrow-right-24:](../reference/architecture.md)

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm build` | Build every package |
| `pnpm start` | Serve the built client from the server |
| `pnpm electron` | Run the desktop shell in dev |
| `pnpm test`, `pnpm test:watch` | vitest |
| `pnpm test:engine`, `pnpm lint:engine` | The SSH engine's own tests, and `cargo fmt` plus clippy |
| `pnpm test:openssh` | The connection stack against a real OpenSSH server in a container: logins, sessions, forwards, files and X11. Needs Docker |
| `pnpm lint` | oxlint (`--deny-warnings`) |
| `pnpm typecheck` | Types across the workspace |

## Native modules and Electron

The desktop build rebuilds `node-pty` and `serialport` against Electron's ABI. Before a
`pnpm electron` dev run:

```bash
pnpm --filter @muxus/electron run rebuild
```

The SSH engine needs no rebuild for Electron: it is an N-API addon, and the same binary loads
in Node and in Electron. `pnpm build` builds it for the computer it runs on and the desktop
bundle carries it beside `main.js`.

## Installers

```bash
make deb    # Linux .deb
make win    # Windows NSIS installers (x64 and ARM64)
make dmg    # macOS .dmg
make all    # everything electron-builder is configured for
```

The Windows and macOS installers cover two CPUs each, so `make win` and `make dmg` build the
SSH engine for both. Add the Rust targets once:

```bash
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc   # for make win
rustup target add aarch64-apple-darwin x86_64-apple-darwin         # for make dmg
```

A Windows installer is built on Windows: it compiles `node-pty` and `serialport` from source,
and `node-pty` needs the **MSVC Spectre-mitigated libs** component of the Visual Studio Build
Tools on top of the C++ tools. For one CPU only:

```bash
pnpm build
pnpm --filter @muxus/electron dist --win nsis --x64
```

Artifacts are written to `electron/release/`.

Windows builds bundle VcXsrv as the X server for [X11 forwarding](../guide/x11.md).
`electron/scripts/vcxsrv.mjs` downloads the pinned upstream installer, checks its
SHA-256 and keeps the files Muxus needs in `electron/vendor/vcxsrv`. Unpacking the
installer needs 7-Zip (`7z` or `7zz` on `PATH`, or `MUXUS_7ZIP`); GitHub's Windows
runners already have it. `dist` prepares the X server itself; run
`node electron/scripts/vcxsrv.mjs` before `pack:dir`.

Publishing a GitHub release runs the installer workflow. After the installers are
attached, that workflow redeploys the documentation site with a `latest.json` generated
from the newest release. The browser-hosted UI, development builds and `.deb` installs
use that manifest for their update checks; installed desktop releases update in the app
from the release's `latest*.yml` feeds (see [Updating Muxus](../install/index.md#updating-muxus)).

## The RDP client (IronRDP)

The RDP client is [IronRDP](https://github.com/Devolutions/IronRDP) compiled to
WebAssembly. Its build output is committed in `client/src/vendor/ironrdp`, so a normal
build needs no Rust. The published npm package lags upstream fixes that xrdp and Windows
servers rely on, so Muxus builds a pinned commit, with the small patches in
`client/scripts/ironrdp/`. To move the pin or change a patch:

```bash
cargo install wasm-pack --version 0.15.0 --locked   # once; rustup provides the pinned toolchain
node client/scripts/build-ironrdp.mjs
```

The script clones IronRDP into `node_modules/.cache/ironrdp`, applies the patches, runs `wasm-pack` with
IronRDP's release flags and rewrites `client/src/vendor/ironrdp`, including its README with
the commit and patch list.

## Serial devices on Linux

Serial ports usually require group membership:

```bash
sudo usermod -aG dialout "$USER"   # or uucp, depending on the distribution
```

Log out and back in afterwards.

## Documentation and screenshots

The site is built with [Zensical](https://zensical.org) through two scripts. They use
`uvx`, so nothing has to be installed globally:

```bash
pnpm serve-docs    # live preview on :8000, opens a browser
pnpm build-docs    # writes site/
```

Screenshots are generated, so they never contain a real host:

```bash
pnpm build         # the capture drives the built client
pnpm capture-docs  # both themes

node hack/capture.mjs               # light only  → docs/assets/screenshots/*.png
THEME=dark node hack/capture.mjs    # dark only   → *-dark.png
node hack/capture.mjs sftp          # only shots whose name contains "sftp"
```

`hack/capture.mjs` boots the sandbox in `hack/demo-env.mjs` first, which provides:

- a throwaway `HOME` under `/tmp` with its own `~/.ssh/config`, keys and `known_hosts`;
- one small in-process SSH server per demo host (shell, SFTP, port forwarding), so
  connections, jump chains, the file browser and the editor are all real;
- a minimal VNC server (`hack/demo-vnc.mjs`) that draws an invented desktop for the
  remote-desktop screenshots;
- demo hostnames mapped onto loopback ports by a `--import` hook, so the screenshots show
  `web-01.prod.internal` while talking to `127.0.0.1`.

The demo hosts run on your computer, so `hack/capture-fakes.mjs` answers the status bar,
the host monitor, container discovery and listening ports with invented readings instead of
your machine's own.

The images-in-the-terminal shot browses a folder of generated pictures
(`hack/demo-gallery.mjs`) with [yazi](https://yazi-rs.github.io). The sandbox does not
install it: have `yazi` on `PATH` or point `MUXUS_DEMO_YAZI` at a release binary. Without
it, that shot draws a chart with a shell script instead.

Capture drives a real browser through `playwright-core`, a dev dependency, and expects
Chrome at `/usr/bin/google-chrome`. Set `CHROME` to override the path.

The animated tour on the landing page comes out of the same sandbox:

```bash
pnpm record-docs   # both themes → docs/assets/screenshots/tour[-dark].mp4

node hack/record.mjs               # light only, plus tour-poster.png
THEME=dark node hack/record.mjs    # dark only
KEEP=1 node hack/record.mjs        # leave the frames in /tmp to re-encode by hand
```

`hack/record.mjs` walks one window through five beats: opening a saved host, splitting the
pane, drawing a chart in the terminal, opening the quick launcher, and using the file
browser and editor. It draws a pointer and caption over the page because a screen recording
captures neither the mouse nor the keys that drove it. Frames come off Chrome's screencast
at device resolution and are stitched with `ffmpeg`, which has to be on `PATH`.

The animated session map behind the landing page hero is generated too, into a theme
partial that `overrides/partials/muxus-hero.html` includes:

```bash
node hack/docs-hero.mjs   # → overrides/partials/muxus-hero-bg.html
```

It lays out terminal panes, links and packets with a fixed seed, so the output only changes
when the script does. Every host is a small element animated on the compositor with
transform and opacity alone, and `docs/assets/javascripts/hero.js` pauses the field while
it is scrolled out of view. Colours come from `docs/assets/stylesheets/extra.css`.

Running `node hack/demo-env.mjs` on its own starts the sandbox and prints a URL, which is
also a way to test a change without touching the real `~/.ssh`.

## CI

Every push runs typecheck, lint, tests and bundle safety checks, then builds unpacked desktop
packages on Linux, macOS and Windows. Pull requests also compare their bundle with the base
commit and fail only when a loading graph grows beyond its configured tolerance.
