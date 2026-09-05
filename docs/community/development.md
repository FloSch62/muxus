---
icon: lucide/hammer
---

# Building from source

## Requirements

- **Node.js ≥ 24.20** for pnpm and build tools
- **pnpm**, using the version pinned in `package.json`
- **Bun 1.4.0**, installed locally by `pnpm install`; use `pnpm exec bun` outside scripts
- A C/C++ toolchain and Python 3 to compile the patched serial binding
- **Go 1.26** for the desktop launcher
- Linux desktop builds: GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, libsecret, and fontconfig
- macOS desktop builds: an Apple Silicon Mac with Xcode command-line tools
- Windows desktop builds: Visual Studio C++ build tools for the host architecture

## Setup

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm dev
```

`pnpm dev` runs three processes in parallel: `shared` in `tsc --watch`, the server on
**:3002**, and the Vite client on **:5174**. Open <http://localhost:5174>.

In dev the API token is the fixed string `dev`, because the Vite client cannot learn a
random one at startup. The server still binds loopback only.

## Project layout

```text
shared/     REST DTOs + the zod WebSocket protocol
server/     Fastify server: ssh_config engine, leases, SFTP, forwards, history
client/     React 19 + MUI, pane canvas, keymap, xterm.js
desktop/    Electrobun shell (embeds the Bun server in-process)
tests/      Vitest units on Bun and native WebKitGTK integration tests
hack/       Documentation sandbox and screenshot capture
```

[The architecture in more detail :octicons-arrow-right-24:](../reference/architecture.md)

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm build` | Build every package |
| `pnpm start` | Serve the built client from the server |
| `pnpm desktop` | Run the desktop shell in dev |
| `pnpm test`, `pnpm test:watch` | vitest |
| `pnpm lint` | oxlint (`--deny-warnings`) |
| `pnpm typecheck` | Types across the workspace |
| `pnpm check:bundle` | Build the client and check bundle safety caps |

## Desktop runtime

The app uses Electrobun 2.0.1 and Bun 1.4.0, with WebKitGTK on Linux, WKWebView on
macOS, and WebView2 on Windows. The server uses `bun:sqlite` and `Bun.Terminal`.
`pnpm install` compiles the patched serial Node-API binding; packaged builds include
that binary and the OS keyring binding. No Electron ABI rebuild is needed.

```bash
pnpm --filter @muxus/desktop prepare:sdk  # required before standalone typechecking
pnpm --filter @muxus/desktop run pack    # unpacked app, after pnpm build
pnpm smoke                              # exercise its bundled Bun and native bindings
pnpm test:desktop                       # Linux; requires webkit2gtk-driver and a display
```

The serial patch replaces Unix libuv polling with POSIX polling and Node-API
callbacks, and retains the Windows USB completion fix. Release packaging requires
its compiled output and excludes unpatched prebuilds.

## Installers

```bash
make deb    # Linux .deb
make win    # Windows installer for the host architecture
make dmg    # macOS .dmg
make all    # native installer for the current platform
```

Artifacts are written to `desktop/artifacts/`. Build on the target OS and architecture.
CI builds Linux x64, Windows x64 and ARM64, and macOS ARM64.

Publishing a GitHub release runs the installer workflow. After the installers are
attached, that workflow redeploys the documentation site with a `latest.json` generated
from the newest release. The desktop app and browser-hosted UI use that manifest for
their update checks.

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

pnpm exec bun hack/capture.mjs               # light only  → docs/assets/screenshots/*.png
THEME=dark pnpm exec bun hack/capture.mjs    # dark only   → *-dark.png
pnpm exec bun hack/capture.mjs sftp          # only shots whose name contains "sftp"
```

`hack/capture.mjs` boots the sandbox in `hack/demo-env.mjs` first, which provides:

- a throwaway `HOME` under `/tmp` with its own `~/.ssh/config`, keys and `known_hosts`;
- one small in-process SSH server per demo host (shell, SFTP, port forwarding), so
  connections, jump chains, the file browser and the editor are all real;
- demo hostnames mapped onto loopback ports by a `--import` hook, so the screenshots show
  `web-01.prod.internal` while talking to `127.0.0.1`.

Capture drives a real browser through `playwright-core`, a dev dependency, and expects
Chrome at `/usr/bin/google-chrome`. Set `CHROME` to override the path.

The animated tour on the landing page comes out of the same sandbox:

```bash
pnpm record-docs   # both themes → docs/assets/screenshots/tour[-dark].mp4

pnpm exec bun hack/record.mjs               # light only, plus tour-poster.png
THEME=dark pnpm exec bun hack/record.mjs    # dark only
KEEP=1 pnpm exec bun hack/record.mjs        # leave the frames in /tmp to re-encode by hand
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

Running `pnpm exec bun hack/demo-env.mjs` on its own starts the sandbox and prints a URL, which is
also a way to test a change without touching the real `~/.ssh`.

## CI

Every push runs typecheck, lint, tests and bundle safety checks, then builds unpacked desktop
packages on Linux, macOS and Windows. Pull requests also compare their bundle with the base
commit and fail only when a loading graph grows beyond its configured tolerance.
