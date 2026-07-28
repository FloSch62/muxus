# Muxus

Muxus is a free, open-source SSH, Telnet and serial client. Split panes, saved workspaces,
SFTP, a remote editor, saved tunnels, and images in the terminal.

**The docs are the main entry point:** [flosch62.github.io/muxus](https://flosch62.github.io/muxus/)

![The Muxus window](docs/assets/screenshots/overview.png)

## Start Here

- [Install Muxus](https://flosch62.github.io/muxus/install/)
- [Quickstart](https://flosch62.github.io/muxus/quickstart/)
- [User guide](https://flosch62.github.io/muxus/guide/)
- [Reference](https://flosch62.github.io/muxus/reference/)
- [Contributing and development](https://flosch62.github.io/muxus/community/)
- [Desktop releases](https://github.com/FloSch62/muxus/releases)

## Run From Source

Requires Go >= 1.25, Node.js >= 24.17 and pnpm:

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm start` runs browser mode. Use `pnpm desktop` for the Wails desktop
window; neither mode uses Electron or a Node server.

For development setup, architecture, the security model and how the screenshots are
generated, use the docs.

## License

[MIT](./LICENSE)
