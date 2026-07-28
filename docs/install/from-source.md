---
icon: lucide/terminal
---

# From source

Muxus builds a React client into one Go executable. The executable can open
the Wails desktop shell or serve the identical UI to a regular browser.

## Requirements

- **Go ≥ 1.25**
- **Node.js ≥ 24.17**
- **pnpm**, using the version pinned by `packageManager`
- Linux build dependencies:

```bash
sudo apt install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
```

## Build and run in a browser

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm build
pnpm start
```

`pnpm start` runs `muxus serve`, binds `127.0.0.1`, mints a random bearer
token and opens a browser. The token arrives in a URL fragment and is removed
immediately.

!!! warning "Not a shared service"

    Muxus is a local single-user tool. Do not expose its port or put it behind
    a reverse proxy.

## Run the desktop shell

```bash
pnpm desktop
```

This launches the same Go backend in a Wails v3 system webview. No Electron
or Node server is involved.

## Development mode

```bash
pnpm dev
```

Open <http://localhost:5174>. Vite proxies to the Go server on `:3002`; the
development token is `dev`, and the server remains loopback-only.

## Build release packages

```bash
pnpm package
```

The archive and executable are written to `build/`. Linux additionally
produces an installable `.deb`. Production Linux builds use `-tags gtk3` for
WebKitGTK 4.1. Packaging enforces the 30,000,000-byte uncompressed executable
limit.

## Useful checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:go
pnpm check:bundle
```

See the [command-line reference](../reference/cli.md) for flags and data
locations.
