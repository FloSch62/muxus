---
icon: lucide/git-pull-request
---

# Contributing

Muxus is a community project, and contributions of any size are welcome.

## Ways to help

- :material-bug: **Report a bug.** Open an issue with steps to reproduce, the platform, and
  the expected behaviour. For connection problems, include the terminal's failure message
  and the relevant redacted `Host` block.
- :material-lightbulb: **Suggest a feature.** Describe the problem to be solved rather than
  only the proposed solution.
- :material-file-document: **Improve the docs.** Every page has an edit pencil linking to
  its source.
- :material-code-tags: **Send a pull request.** See below.

## Before you open a PR

1. [Build from source](development.md) and start the dev servers.
2. Make the change, following the conventions of the surrounding code.
3. Run the checks:

    ```bash
    pnpm typecheck
    pnpm lint
    pnpm test
    ```

4. If the client bundle changed, `pnpm check:bundle` enforces its budgets.

## Project constraints

- **The OpenSSH config is a document.** Anything that writes to it must keep the rest of
  the file byte-identical, write atomically, and leave a `.muxus.bak`. Tests cover this.
- **Never take a key the shell needs.** New chords belong in `client/src/keymap/`, and a
  command that is not applicable must return `false` so the key falls through.
- **Secrets do not go in the database.** The persistence boundary rejects them.
- **Layout changes must not remount terminals.** The pane canvas is flat by design.

## Pull request tips

- Keep PRs focused on one logical change.
- Describe what changed and why, and link any related issue.
- Include screenshots or a short clip for UI changes. The screenshot sandbox
  (`node hack/demo-env.mjs`) provides an environment with invented hosts to record in.

## Editing the docs

The docs are built with [Zensical](https://zensical.org) and live in `docs/`. To preview
them locally:

```bash
pnpm serve-docs   # builds, serves on http://localhost:8000 and opens a browser
```

The preview reloads on save. Screenshots are generated; see
[Building from source](development.md#documentation-and-screenshots).

## Code of conduct

Be kind and constructive. Assume good intent, keep discussions technical, and help
newcomers.
