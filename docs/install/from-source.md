---
icon: lucide/terminal
---

# From source

Muxus is a pnpm workspace of TypeScript packages. Running it from source serves the same UI
to a browser from a local Fastify server.

## Requirements

- **Node.js ≥ 24.20** for pnpm and build tools
- **pnpm**, using the version pinned in `package.json`
- **Bun 1.4.0**, installed locally by `pnpm install`; use `pnpm exec bun` outside scripts
- A C/C++ toolchain and Python 3 to compile the patched serial binding
- **Go 1.26** for the desktop launcher
- Linux desktop builds: GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, libsecret, and fontconfig
- macOS desktop builds: an Apple Silicon Mac with Xcode command-line tools
- Windows desktop builds: Visual Studio C++ build tools for the host architecture

## Build and run

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm build
pnpm start
```

`pnpm start` serves the built client from the server and opens a browser. The server binds
`127.0.0.1` only and mints a random bearer token for that run. The browser receives it in
the URL fragment, which the client removes immediately.

!!! warning "Not a shared service"

    Muxus is a single-user local tool, not a hosted terminal. Do not put it behind a
    reverse proxy or expose the port. See the
    [security model](../reference/security.md).

## Development mode

```bash
pnpm dev        # shared tsc --watch + server on :3002 + Vite client on :5174
```

Open <http://localhost:5174>. In dev the token is the fixed string `dev`, because the Vite
client cannot learn a random one at startup. The server still listens on loopback only.

```bash
pnpm build      # build every package
pnpm start      # serve the built client from the server
pnpm desktop   # run the desktop shell in dev
pnpm test       # vitest unit tests
pnpm lint       # oxlint
pnpm typecheck
```

`pnpm desktop` uses a separate `Muxus-development` user-data directory. At every launch,
its application database is refreshed from the installed Muxus database when one exists;
the installed application's database is never opened for writes by the development build.
Session history and automatic password-vault keys are also placed in development-only
storage, so cleanup or settings changes cannot affect the installed application.

The desktop runtime is Electrobun 2.0.1 with Bun 1.4.0 and the system webview.
`pnpm install` compiles the patched serial binding; the packaged application
includes Bun and all required native bindings. No separately installed runtime is
needed to run a release.

## Desktop installers

```bash
make deb    # Linux .deb
make win    # Windows installer for the host architecture
make dmg    # macOS .dmg
make all    # native installer for the current platform
```

Artifacts are written to `desktop/artifacts/`. Build on the target OS and architecture.
CI builds Linux x64, Windows x64 and ARM64, and macOS ARM64.

## Command-line flags

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to bind on `127.0.0.1` (default `3002`, or `$PORT`) |
| `--no-open` | Do not open a browser on start (also `MUXUS_NO_OPEN=1`) |
| `--history-path <dir>` | Where session history is written (also `MUXUS_HISTORY_PATH`) |

The full list, including environment variables, is in the
[command-line reference](../reference/cli.md).
