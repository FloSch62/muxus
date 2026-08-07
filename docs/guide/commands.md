---
icon: lucide/zap
---

# Command buttons & multi-exec

Command buttons save a command for one-click execution. Multi-execution mirrors keystrokes
into several sessions at once.

## Command buttons

By default, saved commands appear in a bar above the terminal. One click sends the command
to the focused session.

<figure markdown="span">
  ![The command button bar above a session](../assets/screenshots/command-buttons.png#only-light){ .shadow }
  ![The command button bar above a session](../assets/screenshots/command-buttons-dark.png#only-dark){ .shadow }
  <figcaption>The bar appears once at least one command has been saved.</figcaption>
</figure>

Buttons are managed with the :material-flash: control in the top bar. Each button has:

- a **label**, which is displayed, and a **command**, which is sent;
- a **Run immediately** switch. On, the command runs. Off, it is inserted at the prompt for
  review and submitted with ++enter++.

Insert-only is the appropriate mode for destructive commands.

Buttons are disabled while the focused tab is not connected, and their order is
configurable.

Turn off **Show command bar** in the command-button manager to reclaim the vertical space
and use only the keyboard menu. This hides the bar without deleting any saved commands.

### Keyboard menu

Press ++ctrl+space++ to open a compact menu beside the active terminal cursor. Start
typing to search command labels and command text, use ++up++ and ++down++ to choose a
result, then press ++enter++ to send it. The menu also links to **Manage command
buttons** so commands can be added or reordered without reaching for the mouse.

The shortcut is rebindable under **Terminal → Show saved command menu** in the
[keyboard sheet](../reference/keyboard-shortcuts.md).

## Multi-execution

Multi-execution mirrors keystrokes into several live terminals at once.

<figure markdown="span">
  ![Selecting terminals for multi-execution](../assets/screenshots/multi-exec.png#only-light){ .shadow }
  ![Selecting terminals for multi-execution](../assets/screenshots/multi-exec-dark.png#only-dark){ .shadow }
  <figcaption>Selected sessions receive the input typed into any one of them.</figcaption>
</figure>

1. Open the multi-exec control in the top bar.
2. Select at least **two** connected sessions, either individually or with the presets
   **This split**, **Visible splits** and **All live**. The control turns **Active**.
3. Type in any selected terminal. Every selected terminal receives the same input.
4. **Clear selection** when finished.

!!! danger "Mirrored input reaches every selected session"

    This includes any session where a prompt is waiting for confirmation. The control stays
    visibly **Active** while mirroring is on.

### Switching it off and on

++ctrl+shift+m++ toggles mirroring without opening the control, so a mirrored command can be
followed by a single-session one and back. Switching it on again restores the same
selection, minus any session that has since closed.

Pressed with nothing selected yet, it mirrors one session per split currently on screen.
With fewer than two of those, it says so and leaves mirroring off.

The chord is rebindable like every other, under **Terminal → Toggle multi-execution** in the
[keyboard sheet](../reference/keyboard-shortcuts.md).

### Saved groups

A selection of two or more sessions can be saved as a named **group** and re-activated in
one click. Groups are stored with the [workspace](workspaces.md#multi-exec-groups), and
each one reports how many of its tabs are currently connected.
