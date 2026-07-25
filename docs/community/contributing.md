---
icon: lucide/git-pull-request
---

# Contributing

Thanks for considering a contribution. Muxus is a community project and every bit helps —
from typo fixes to whole features.

## Ways to help

- :material-bug: **Report a bug** — open an issue with steps to reproduce, your platform,
  and what you expected. For connection problems, the terminal's failure message and the
  relevant (redacted) `Host` block are gold.
- :material-lightbulb: **Suggest a feature** — describe the problem you are trying to
  solve, not just the solution.
- :material-file-document: **Improve the docs** — every page has an edit pencil that takes
  you straight to its source.
- :material-code-tags: **Send a pull request** — see below.

## Before you open a PR

1. [Build from source](development.md) and get the dev servers running.
2. Make your change, keeping the surrounding code's style and conventions.
3. Run the checks:

    ```bash
    pnpm typecheck
    pnpm lint
    pnpm test
    ```

4. If you touched the client bundle, `pnpm check:bundle` enforces its budgets.

## Things worth knowing

- **The OpenSSH config is a document.** Anything that writes to it must keep the rest of
  the file byte-identical, write atomically, and leave a `.muxus.bak`. There are tests for
  this.
- **Never take a key the shell needs.** New chords belong in `client/src/keymap/`, and a
  command that is not applicable must return `false` so the key falls through.
- **Secrets do not go in the database.** The persistence boundary rejects them; if you find
  yourself working around it, the design is wrong.
- **Layout changes must not remount terminals.** The pane canvas is flat on purpose.

## Pull request tips

- Keep PRs focused — one logical change per PR is easier to review.
- Describe **what** and **why**, and link any related issue.
- Screenshots or a short clip help enormously for UI changes. The docs' screenshot sandbox
  (`node hack/demo-env.mjs`) gives you a safe environment with invented hosts to record in.

## Editing the docs

These docs are built with [Zensical](https://zensical.org) and live in `docs/`. To preview
them locally:

```bash
pnpm serve-docs   # builds, serves on http://localhost:8000 and opens a browser
```

Edit the Markdown and the preview reloads as you save. Screenshots are generated — see
[Building from source](development.md#documentation-and-screenshots).

## Code of conduct

Be kind and constructive. Assume good intent, keep discussions technical, and help
newcomers.
