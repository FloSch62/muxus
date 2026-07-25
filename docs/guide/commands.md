---
icon: lucide/zap
---

# Command buttons & multi-exec

Two ways to stop typing the same thing: save a command as a button, or type once into
several sessions at the same time.

## Command buttons

Saved commands appear in a bar above the terminal. One click sends the command to the
focused session.

<figure markdown="span">
  ![The command button bar above a session](../assets/screenshots/command-buttons.png#only-light){ .shadow }
  ![The command button bar above a session](../assets/screenshots/command-buttons-dark.png#only-dark){ .shadow }
  <figcaption>The bar only appears once you have saved something — an empty toolbar helps nobody.</figcaption>
</figure>

Manage them with the :material-flash: button in the top bar. Each button has:

- a **label** (what you see) and a **command** (what is sent);
- a **Run immediately** switch: on, the command runs; off, it is only *inserted* at the
  prompt so you can read it, edit it, and press ++enter++ yourself.

Insert-only is the right default for anything with `rm`, `restart` or `--force` in it.

Buttons are disabled while the focused tab is not connected, and their order is yours to
set.

## Multi-execution

Multi-exec mirrors your keystrokes into several live terminals at once — the "run this on
all four web nodes" move.

<figure markdown="span">
  ![Selecting terminals for multi-execution](../assets/screenshots/multi-exec.png#only-light){ .shadow }
  ![Selecting terminals for multi-execution](../assets/screenshots/multi-exec-dark.png#only-dark){ .shadow }
  <figcaption>Pick the sessions; typing in any one of them goes to all of them.</figcaption>
</figure>

1. Open the multi-exec control in the top bar.
2. Select at least **two** connected sessions — tick them, or use the presets:
   **This split**, **Visible splits**, **All live**. The control turns **Active**.
3. Type in any selected terminal — every selected terminal receives the same input.
4. **Clear selection** when you are done.

!!! danger "It is exactly as blunt as it sounds"

    Mirrored input goes to every selected session, including the one where a prompt is
    waiting for `yes`. The control stays visibly **Active** while mirroring is on for
    precisely this reason.

### Saved groups

A selection of two or more can be saved as a named **group** — "web tier", "all leaves" —
and re-activated in one click. Groups are stored with the
[workspace](workspaces.md#multi-exec-groups-travel-with-the-workspace), and each one shows
how many of its tabs are currently connected.
