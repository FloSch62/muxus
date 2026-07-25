---
icon: lucide/hammer
---

# Building from source

## Requirements

- **Node.js ≥ 24.17** (CI builds on 24.18)
- **pnpm** — the version is pinned in `package.json` through `packageManager`
- A C/C++ toolchain for the two native modules (`node-pty`, `serialport`)

## Setup

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm dev
```

`pnpm dev` runs three things in parallel: `shared` in `tsc --watch`, the server on
**:3002**, and the Vite client on **:5174**. Open <http://localhost:5174>.

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
| `pnpm test` · `pnpm test:watch` | vitest |
| `pnpm lint` | oxlint (`--deny-warnings`) |
| `pnpm typecheck` | Types across the workspace |
| `pnpm check:bundle` | Client bundle budgets |

## Native modules and Electron

The desktop build rebuilds `node-pty` and `serialport` against Electron's ABI. Before a
`pnpm electron` dev run:

```bash
pnpm --filter @muxus/electron rebuild
```

## Installers

```bash
make deb    # Linux .deb
make win    # Windows NSIS installer
make dmg    # macOS .dmg
make all    # everything electron-builder is configured for
```

Artifacts land in `electron/release/`.

## Serial devices on Linux

Serial ports usually need group membership:

```bash
sudo usermod -aG dialout "$USER"   # or uucp, depending on the distribution
```

Log out and back in afterwards.

## Documentation and screenshots

The site is [Zensical](https://zensical.org), driven through two scripts (they use
`uvx`, so nothing has to be installed globally):

```bash
pnpm serve-docs    # live preview on :8000, opens a browser
pnpm build-docs    # writes site/
```

Screenshots are **generated**, so they never contain a real host:

```bash
pnpm build         # the capture drives the built client
pnpm capture-docs  # both themes

node hack/capture.mjs               # light only  → docs/assets/screenshots/*.png
THEME=dark node hack/capture.mjs    # dark only   → *-dark.png
node hack/capture.mjs sftp          # only shots whose name contains "sftp"
```

`hack/capture.mjs` boots the sandbox in `hack/demo-env.mjs` first:

- a throwaway `HOME` under `/tmp` with its own `~/.ssh/config`, keys and `known_hosts`;
- one small in-process SSH server per demo host (shell, SFTP, port forwarding), so
  connections, jump chains, the file browser and the editor are all real;
- demo hostnames mapped onto loopback ports by a `--import` hook, so the screenshots show
  `web-01.prod.internal` while talking to `127.0.0.1`.

Capture drives a real browser through `playwright-core` (a dev dependency) and expects
Chrome at `/usr/bin/google-chrome`; point `CHROME` somewhere else if yours lives elsewhere.

Run `node hack/demo-env.mjs` on its own to get the sandbox with a URL printed, which is
also a pleasant way to try a change without touching your own `~/.ssh`.

## CI

Every push runs typecheck, lint, tests and the bundle budgets, then builds unpacked
desktop packages on Linux, macOS and Windows.
