---
icon: lucide/hammer
---

# Building from source

## Requirements

- **Go ≥ 1.25**
- **Node.js ≥ 24.17** (CI builds on 24.18)
- **pnpm**, with the version pinned in `package.json` through `packageManager`
- On Linux: a C toolchain, `pkg-config`, GTK 3 and WebKitGTK 4.1 headers

On Debian/Ubuntu:

```bash
sudo apt install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
```

The installed application is one Go executable. Node and pnpm are build-time
tools for the React client, not runtime dependencies.

## Setup

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm dev
```

`pnpm dev` runs the shared TypeScript watcher, Vite on **:5174**, and
`go run -tags gtk3 ./cmd/muxus serve --port 3002`. Open
<http://localhost:5174>.

In development the API token is the fixed string `dev`, because Vite cannot
learn a random token at startup. The Go server still binds loopback only.

## Project layout

```text
app/        Go backend, Wails shell, persistence, transports and embedded client
shared/     REST DTOs + the zod WebSocket protocol
client/     React 19 + MUI, pane canvas, keymap and xterm.js
tests/      vitest client/shared tests and cross-language contract fixtures
packaging/  Native bundle metadata
hack/       Build, development and documentation tooling
```

[The architecture in more detail :octicons-arrow-right-24:](../reference/architecture.md)

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Go browser server + Vite + shared watcher |
| `pnpm start` | Run `muxus serve` from source against the built client |
| `pnpm desktop` | Build the web client and run the Wails desktop shell |
| `pnpm build` | Build the client, embed it and create `build/muxus[.exe]` |
| `pnpm package` | Build and create the current platform's release archive |
| `pnpm test`, `pnpm test:watch` | vitest client/shared/contract tests |
| `pnpm test:go` | Go contract, backend, transport and shell tests |
| `pnpm lint` | oxlint (`--deny-warnings`) |
| `pnpm typecheck` | Types across the TypeScript workspace |
| `pnpm check:bundle` | Client bundle budgets |

Linux Go commands intentionally use `-tags gtk3`, which selects
webkit2gtk-4.1 rather than the newer GTK 4/WebKitGTK 6 stack.

## Release packages

```bash
pnpm package
```

The command writes a portable archive to `build/`:

- Linux: `muxus-v<version>-linux-<arch>.tar.gz`
- Windows: `muxus-v<version>-windows-<arch>.zip`
- macOS: `muxus-v<version>-macos-<arch>.zip` containing `Muxus.app`

The packaging step fails if the uncompressed production executable exceeds
30,000,000 bytes. Publishing a GitHub release builds all three platforms and
then refreshes the documentation site's `latest.json` update manifest.

## Serial devices on Linux

Serial ports usually require group membership:

```bash
sudo usermod -aG dialout "$USER"   # or uucp, depending on the distribution
```

Log out and back in afterwards.

## Documentation and screenshots

The site is built with [Zensical](https://zensical.org) through two scripts.
They use `uvx`, so nothing has to be installed globally:

```bash
pnpm serve-docs    # live preview on :8000, opens a browser
pnpm build-docs    # writes site/
```

Screenshots are generated, so they never contain a real host:

```bash
pnpm build
pnpm capture-docs  # both themes

node hack/capture.mjs               # light only
THEME=dark node hack/capture.mjs    # dark only
node hack/capture.mjs sftp          # only matching shots
```

`hack/capture.mjs` boots `hack/demo-env.mjs`, which provides a throwaway
home directory and small in-process SSH servers for shell, SFTP and
forwarding. `MUXUS_DEMO_HOSTMAP` makes invented documentation hostnames dial
those loopback servers without changing what the UI displays.

Capture uses `playwright-core` and expects Chrome at
`/usr/bin/google-chrome`; set `CHROME` to override it.

The animated tour comes from the same sandbox:

```bash
pnpm record-docs   # both themes

node hack/record.mjs
THEME=dark node hack/record.mjs
KEEP=1 node hack/record.mjs
```

`ffmpeg` must be on `PATH` for recording.

## CI

Every push runs the TypeScript and Go test suites, contract checks, lint,
typecheck and bundle budgets. It then builds and packages the Wails
application on Linux, macOS and Windows.
