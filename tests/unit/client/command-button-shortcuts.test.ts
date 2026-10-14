import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasswordVaultStatus, SessionProfile } from '@muxus/shared';
import { captureChords } from '../../../client/src/components/useChordCapture.js';
import {
  commandsForChord,
  commandsForEvent,
  conflictingCommandIds,
} from '../../../client/src/keymap/bindings.js';
import { formatChordString } from '../../../client/src/keymap/chords.js';
import {
  commandButtonCommandId,
  commandButtonCommands,
  commandButtonShortcut,
  commandButtonShortcutConflict,
  runCommandButtonShortcut,
} from '../../../client/src/keymap/command-buttons.js';
import { installShortcuts } from '../../../client/src/shortcuts.js';
import { useMultiExecStore } from '../../../client/src/state/multi-exec.js';
import { usePrefsStore, type CommandButton } from '../../../client/src/state/prefs.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';
import { useUiStore } from '../../../client/src/state/ui.js';
import { runCommandButton } from '../../../client/src/vault-secrets.js';

// Shortcuts must take the click path; what that path types is covered by its own tests.
vi.mock('../../../client/src/vault-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runCommandButton: vi.fn(() => true),
}));
const runMock = vi.mocked(runCommandButton);

type ShortcutQueryClient = NonNullable<Parameters<typeof runCommandButtonShortcut>[1]>;

const version: CommandButton = {
  id: 'version',
  label: 'Version',
  command: 'show version',
  sendEnter: true,
  shortcut: 'Ctrl+Alt+KeyV',
};
const enable: CommandButton = {
  id: 'enable',
  label: 'Enable',
  command: '',
  sendEnter: true,
  secretId: 's1',
  shortcut: 'Ctrl+Alt+KeyE',
};
const unbound: CommandButton = { id: 'disk', label: 'Disk', command: 'df -h', sendEnter: true };
const buttons = [version, enable, unbound];

const vaultWith = (status: PasswordVaultStatus | undefined) =>
  ({ getQueryData: () => status }) as unknown as ShortcutQueryClient;
const vault = { secrets: [{ id: 's1', name: 'Core enable', createdAt: '', updatedAt: '' }] };

function openTab(profile: SessionProfile, status: 'connected' | 'connecting' = 'connected') {
  const id = useTabsStore.getState().open(profile, profile.kind);
  useTabsStore.getState().update(id, { status });
  return id;
}

beforeEach(() => {
  runMock.mockClear();
  useMultiExecStore.setState({ selectedIds: [], lastMirroredIds: [], groups: [] });
  useTabsStore.setState({
    tabs: [],
    root: { id: 'pane-shortcuts', type: 'pane', activeTabId: null },
    activePaneId: 'pane-shortcuts',
    activeId: null,
    zoomedPaneId: null,
  });
});

describe('command button shortcuts in the keymap', () => {
  it('registers only the buttons that carry a shortcut', () => {
    const commands = commandButtonCommands(buttons);
    expect(commands.map((command) => command.id)).toEqual([
      commandButtonCommandId('version'),
      commandButtonCommandId('enable'),
    ]);
    expect(commands[0]).toMatchObject({
      title: 'Version',
      category: 'buttons',
      defaultChords: ['Ctrl+Alt+KeyV'],
      palette: false,
    });
    expect(commandButtonCommands([unbound])).toEqual([]);
  });

  it('dispatches a pressed chord to its button, after the app commands', () => {
    const commands = commandButtonCommands(buttons);
    const event = {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    };
    expect(commandsForEvent(event, {}, commands).map((command) => command.id)).toEqual([
      commandButtonCommandId('version'),
    ]);
    // A chord the app also binds reaches the app command first.
    const clashing = commandButtonCommands([{ ...version, shortcut: 'Alt+Shift+ArrowRight' }]);
    expect(
      commandsForChord('Alt+Shift+ArrowRight', {}, clashing).map((command) => command.id),
    ).toEqual(['tab.to-pane.right', commandButtonCommandId('version')]);
    expect([...conflictingCommandIds({}, clashing)].sort()).toEqual([
      commandButtonCommandId('version'),
      'tab.to-pane.right',
    ]);
    expect(conflictingCommandIds({}, commands).size).toBe(0);
  });
});

describe('running a button from its shortcut', () => {
  it('leaves the key to the shell without a connected terminal in focus', () => {
    expect(runCommandButtonShortcut(version)).toBe(false);

    openTab({ kind: 'local' }, 'connecting');
    expect(runCommandButtonShortcut(version)).toBe(false);

    openTab({ kind: 'rdp', host: 'desktop', port: 3389 });
    expect(runCommandButtonShortcut(version)).toBe(false);

    expect(runMock).not.toHaveBeenCalled();
  });

  it('runs the button through the click path in the focused session', () => {
    const id = openTab({ kind: 'local' });
    const command = commandButtonCommands([version])[0]!;

    expect(command.run()).toBe(true);
    expect(runMock).toHaveBeenCalledExactlyOnceWith(id, version, {
      secretName: undefined,
      queryClient: undefined,
    });

    // A send that fails is reported as not applicable.
    runMock.mockReturnValueOnce(false);
    expect(command.run()).toBe(false);
  });

  it('types a secret under its vault name, with the query client a click passes', () => {
    const id = openTab({ kind: 'ssh', target: 'core-1' });
    const queryClient = vaultWith(vault as unknown as PasswordVaultStatus);

    expect(runCommandButtonShortcut(enable, queryClient)).toBe(true);
    expect(runMock).toHaveBeenCalledExactlyOnceWith(id, enable, {
      secretName: 'Core enable',
      queryClient,
    });
  });

  it('declines a button that has nothing to send, as the Ctrl+Space menu does', () => {
    openTab({ kind: 'local' });
    expect(runCommandButtonShortcut({ ...version, command: '  ' })).toBe(false);
    expect(runCommandButtonShortcut({ ...enable, secretId: '' })).toBe(false);
    const emptyVault = vaultWith({ secrets: [] } as unknown as PasswordVaultStatus);
    expect(runCommandButtonShortcut(enable, emptyVault)).toBe(false);
    expect(runMock).not.toHaveBeenCalled();

    // Before the vault status has loaded the backend decides, as for a click.
    expect(runCommandButtonShortcut(enable, vaultWith(undefined))).toBe(true);
  });
});

describe('recording a button shortcut', () => {
  const prefs = { keybindings: {}, commandButtons: buttons };

  it('accepts a free chord and the chord the button already has', () => {
    expect(commandButtonShortcutConflict('Ctrl+Alt+KeyS', 'disk', prefs)).toBeUndefined();
    expect(commandButtonShortcutConflict('Ctrl+Alt+KeyV', 'version', prefs)).toBeUndefined();
  });

  it('refuses a chord an app command answers to, and names the command', () => {
    expect(commandButtonShortcutConflict('Alt+Shift+ArrowRight', 'disk', prefs)).toBe(
      `${formatChordString('Alt+Shift+ArrowRight')} already runs “Move tab to pane right”.`,
    );
    // Once the user unbinds the command, the chord is free.
    expect(
      commandButtonShortcutConflict('Alt+Shift+ArrowRight', 'disk', {
        ...prefs,
        keybindings: { 'tab.to-pane.right': [] },
      }),
    ).toBeUndefined();
    // A rebound chord is taken where the user put it.
    expect(
      commandButtonShortcutConflict('Ctrl+Alt+KeyS', 'disk', {
        ...prefs,
        keybindings: { 'terminal.send-break': ['Ctrl+Alt+KeyS'] },
      }),
    ).toBe(`${formatChordString('Ctrl+Alt+KeyS')} already runs “Send BREAK”.`);
  });

  it('refuses a chord another button holds, and names the button', () => {
    expect(commandButtonShortcutConflict('Ctrl+Alt+KeyV', 'disk', prefs)).toBe(
      `${formatChordString('Ctrl+Alt+KeyV')} already runs the command button “Version”.`,
    );
  });

  it('refuses the chords the shell keeps, and says so', () => {
    for (const chord of [
      'Ctrl+KeyC',
      'Ctrl+KeyD',
      'Ctrl+KeyW',
      'Ctrl+BracketLeft',
      'Ctrl+Digit2',
      'Ctrl+Digit3',
      'Ctrl+Backspace',
      'Ctrl+Shift+Minus',
    ]) {
      expect(commandButtonShortcutConflict(chord, 'disk', prefs), chord).toBe(
        `${formatChordString(chord)} is kept for the shell.`,
      );
    }
    expect(commandButtonShortcutConflict('Ctrl+Shift+KeyY', 'disk', prefs)).toBeUndefined();
    expect(commandButtonShortcutConflict('Ctrl+Alt+KeyC', 'disk', prefs)).toBeUndefined();
  });
});

/**
 * A stand-in window that, like a browser, reads `true` as the capture flag when
 * a listener is removed. Node 24's EventTarget only reads `{ capture: true }`
 * there, so the app's capture listeners would never come off.
 */
/** A focused element: inside the terminal, or a control elsewhere (a dialog button, a sidebar row). */
class StandInElement {
  constructor(private readonly inTerminal: boolean) {}
  closest(selector: string): StandInElement | null {
    return selector === '.xterm' && this.inTerminal ? this : null;
  }
}
const terminalFocus = new StandInElement(true);
const elsewhereFocus = new StandInElement(false);

class StandInWindow extends EventTarget {
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const flattened = typeof options === 'boolean' ? { capture: options } : options;
    super.removeEventListener(type, listener, flattened);
  }
}

describe('pressing a button shortcut', () => {
  let uninstall: (() => void) | undefined;
  let target: EventTarget;

  /** The app's keydown listener on a stand-in window; returns whether the key was taken. */
  function install() {
    target = new StandInWindow();
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', { documentElement: { classList: { toggle() {}, remove() {} } } });
    vi.stubGlobal('Element', StandInElement);
    uninstall = installShortcuts();
    return (
      key: string,
      code: string,
      modifiers: { ctrlKey?: boolean; altKey?: boolean },
      repeat = false,
      focus = terminalFocus,
    ) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), {
        key,
        code,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: false,
        repeat,
        ...modifiers,
      });
      Object.defineProperty(event, 'target', { value: focus });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
  }

  /** Whether the focused control, listening after the app, sees the key's keyup. */
  function release(key: string, code: string) {
    const control = vi.fn();
    target.addEventListener('keyup', control);
    target.dispatchEvent(Object.assign(new Event('keyup'), { key, code, repeat: false }));
    target.removeEventListener('keyup', control);
    return control.mock.calls.length > 0;
  }

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.unstubAllGlobals();
    usePrefsStore.setState({ commandButtons: [] });
    useUiStore.getState().setCommandButtonMenuOpen(false);
  });

  it('runs the button once per press; auto-repeat is swallowed, not run again', () => {
    const id = openTab({ kind: 'local' });
    usePrefsStore.setState({ commandButtons: buttons });
    const press = install();

    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true })).toBe(true);
    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true }, true)).toBe(true);
    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true }, true)).toBe(true);
    expect(runMock).toHaveBeenCalledExactlyOnceWith(id, version, {
      secretName: undefined,
      queryClient: undefined,
    });

    // A new press runs it again.
    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true })).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('leaves the key alone while focus is outside the terminal, as in a dialog or the sidebar', () => {
    openTab({ kind: 'local' });
    usePrefsStore.setState({ commandButtons: buttons });
    const press = install();

    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true }, false, elsewhereFocus)).toBe(false);
    expect(release('v', 'KeyV')).toBe(true);
    expect(runMock).not.toHaveBeenCalled();
    // App commands still answer from there.
    expect(press(' ', 'Space', { ctrlKey: true }, false, elsewhereFocus)).toBe(true);
    expect(useUiStore.getState().commandButtonMenuOpen).toBe(true);
  });

  it('leaves the key and its repeats to the shell when the press did not run the button', () => {
    usePrefsStore.setState({ commandButtons: buttons });
    const press = install();

    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true })).toBe(false);
    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true }, true)).toBe(false);
    expect(release('v', 'KeyV')).toBe(true);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('keeps the keyup of a press that ran a button from the focused shortcut chip', () => {
    openTab({ kind: 'local' });
    usePrefsStore.setState({ commandButtons: [{ ...version, shortcut: 'Ctrl+Alt+Backspace' }] });
    const press = install();
    const chord = { ctrlKey: true, altKey: true };

    // A chip deletes itself on a Backspace keyup, modifiers or not.
    expect(press('Backspace', 'Backspace', chord)).toBe(true);
    expect(press('Backspace', 'Backspace', chord, true)).toBe(true);
    expect(release('Control', 'ControlLeft')).toBe(true);
    expect(release('Alt', 'AltLeft')).toBe(true);
    expect(release('Backspace', 'Backspace')).toBe(false);
    // One keyup per press, however long it was held.
    expect(release('Backspace', 'Backspace')).toBe(true);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('leaves a chord the shell owns to the shell, even when saved prefs still hold it', () => {
    openTab({ kind: 'local' });
    // Rehydrating prefs of the same version skips migration, so nothing normalized this.
    const interrupt = { ...version, shortcut: 'Ctrl+KeyC' };
    usePrefsStore.setState({ commandButtons: [interrupt] });
    const press = install();

    expect(commandButtonCommands([interrupt])).toEqual([]);
    expect(press('c', 'KeyC', { ctrlKey: true })).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
    // The bar and the Ctrl+Space menu advertise only a chord that runs.
    expect(commandButtonShortcut(interrupt)).toBeUndefined();
    expect(commandButtonShortcut(version)).toBe('Ctrl+Alt+KeyV');
    expect(commandButtonShortcut(unbound)).toBeUndefined();
  });

  it('still repeats app commands', () => {
    const press = install();
    expect(press(' ', 'Space', { ctrlKey: true }, true)).toBe(true);
    expect(useUiStore.getState().commandButtonMenuOpen).toBe(true);
    // Their keyups reach the page, as before.
    expect(press(' ', 'Space', { ctrlKey: true })).toBe(true);
    expect(release(' ', 'Space')).toBe(true);
  });
});

describe('recording a chord', () => {
  const handlers = { onChord: vi.fn(), onCancel: vi.fn(), onRefused: vi.fn() };
  let page: EventTarget;
  let stop: (() => void) | undefined;

  /** Records on a stand-in window. Page listeners are added after it, as they run after its capture phase. */
  function record() {
    page = new StandInWindow();
    vi.stubGlobal('window', page);
    stop = captureChords(() => handlers);
  }

  function send(
    type: 'keydown' | 'keyup',
    key: string,
    code: string,
    modifiers: { shiftKey?: boolean; metaKey?: boolean } = {},
    repeat = false,
  ) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key,
      code,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      repeat,
      ...modifiers,
    });
    page.dispatchEvent(event);
    return event;
  }

  /** A recorded chord ends recording while its key is still down. */
  function stopRecording() {
    stop?.();
    stop = undefined;
  }

  afterEach(() => {
    stopRecording();
    vi.unstubAllGlobals();
    for (const handler of Object.values(handlers)) handler.mockClear();
  });

  it('takes chords, refuses Shift alone and cancels on Esc, until stopped', () => {
    record();
    expect(send('keydown', 'k', 'KeyK', { shiftKey: true, metaKey: true }).defaultPrevented).toBe(true);
    expect(handlers.onChord).toHaveBeenCalledExactlyOnceWith({
      code: 'KeyK',
      ctrl: false,
      alt: false,
      shift: true,
      meta: true,
    });
    send('keydown', 'T', 'KeyT', { shiftKey: true });
    expect(handlers.onRefused).toHaveBeenCalledOnce();
    send('keydown', 'Escape', 'Escape');
    expect(handlers.onCancel).toHaveBeenCalledOnce();

    stopRecording();
    expect(send('keydown', 'k', 'KeyK', { metaKey: true }).defaultPrevented).toBe(false);
    expect(handlers.onChord).toHaveBeenCalledOnce();
  });

  it('keeps the recorded key’s keyup from the focused chip, which would delete the new shortcut', () => {
    record();
    // The modifier's own press is not recorded, so its keyup still reaches the page.
    send('keydown', 'Meta', 'MetaLeft', { metaKey: true });
    send('keydown', 'Backspace', 'Backspace', { metaKey: true });
    expect(handlers.onRefused).not.toHaveBeenCalled();
    stopRecording();
    const chip = vi.fn((event: Event) => (event as KeyboardEvent).code);
    page.addEventListener('keyup', chip);

    send('keyup', 'Meta', 'MetaLeft');
    send('keyup', 'Backspace', 'Backspace');
    expect(chip.mock.results.map((result) => result.value)).toEqual(['MetaLeft']);

    // The next press is the user's own.
    send('keydown', 'Backspace', 'Backspace');
    send('keyup', 'Backspace', 'Backspace');
    expect(chip.mock.results.map((result) => result.value)).toEqual(['MetaLeft', 'Backspace']);
  });

  it('stops waiting for a keyup that never came once the key is pressed again', () => {
    record();
    send('keydown', 'k', 'KeyK', { metaKey: true });
    stopRecording();
    const chip = vi.fn();
    page.addEventListener('keyup', chip);

    // macOS sends no keyup for a key released while Cmd is held.
    send('keydown', 'k', 'KeyK');
    send('keyup', 'k', 'KeyK');
    expect(chip).toHaveBeenCalledOnce();
  });

  it('keeps waiting while the recorded key repeats after recording ended', () => {
    record();
    send('keydown', 'Backspace', 'Backspace', { metaKey: true });
    stopRecording();
    const chip = vi.fn();
    page.addEventListener('keyup', chip);

    send('keydown', 'Backspace', 'Backspace', { metaKey: true }, true);
    send('keyup', 'Backspace', 'Backspace');
    expect(chip).not.toHaveBeenCalled();
  });

  it('awaits one keyup per recorded press, however long the key was held', () => {
    record();
    send('keydown', 'k', 'KeyK', { metaKey: true });
    send('keydown', 'k', 'KeyK', { metaKey: true }, true);
    send('keydown', 'k', 'KeyK', { metaKey: true }, true);
    stopRecording();
    const chip = vi.fn();
    page.addEventListener('keyup', chip);

    send('keyup', 'k', 'KeyK');
    expect(chip).not.toHaveBeenCalled();
    // Nothing is left waiting: a later keyup of the key reaches the page.
    send('keyup', 'k', 'KeyK');
    expect(chip).toHaveBeenCalledOnce();
  });
});
