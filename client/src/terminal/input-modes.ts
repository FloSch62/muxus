import {
  withEnterKey,
  type OpenSshMetadataPatch,
  type OpenSshProfileMetadata,
  type TerminalBackspaceKey,
  type TerminalEnterKey,
} from '@muxus/shared';

/** What a host's Backspace and Enter keys send, and how its terminal shows lines and input. */
export interface TerminalInputModes {
  backspaceKey: TerminalBackspaceKey;
  enterKey: TerminalEnterKey;
  /** xterm.js `convertEol`: a received LF also returns to the start of the line. */
  implicitCr: boolean;
  localEcho: boolean;
}

type HostInputModes = Pick<
  OpenSshProfileMetadata,
  'backspaceKey' | 'enterKey' | 'implicitCr' | 'localEcho'
>;

/** C0 and C1 controls but the CR LF shown for Enter; xterm.js would answer C1 queries. */
// oxlint-disable-next-line no-control-regex
const UNSHOWN_CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export const BACKSPACE_KEY_OPTIONS: ReadonlyArray<{ value: TerminalBackspaceKey; label: string }> = [
  { value: 'del', label: 'DEL, 0x7F (default)' },
  { value: 'ctrl-h', label: '^H, 0x08' },
];

export const ENTER_KEY_OPTIONS: ReadonlyArray<{ value: TerminalEnterKey; label: string }> = [
  { value: 'cr', label: 'CR (default)' },
  { value: 'crlf', label: 'CR LF' },
  { value: 'lf', label: 'LF' },
];

/** A host's modes; whatever it leaves unset keeps what xterm.js does. */
export function hostTerminalInputModes(host: HostInputModes | undefined): TerminalInputModes {
  return {
    backspaceKey: host?.backspaceKey ?? 'del',
    enterKey: host?.enterKey ?? 'cr',
    implicitCr: host?.implicitCr ?? false,
    localEcho: host?.localEcho ?? false,
  };
}

/** Whether a host changes anything about its keys or echo. */
export function customTerminalInputModes(modes: TerminalInputModes): boolean {
  return (
    modes.backspaceKey !== 'del' || modes.enterKey !== 'cr' || modes.implicitCr || modes.localEcho
  );
}

/** The modes as a metadata patch; the defaults are stored as unset. */
export function terminalInputModesPatch(
  modes: TerminalInputModes,
): Pick<OpenSshMetadataPatch, 'backspaceKey' | 'enterKey' | 'implicitCr' | 'localEcho'> {
  return {
    backspaceKey: modes.backspaceKey === 'del' ? null : modes.backspaceKey,
    enterKey: modes.enterKey === 'cr' ? null : modes.enterKey,
    implicitCr: modes.implicitCr,
    localEcho: modes.localEcho,
  };
}

/**
 * One keystroke as xterm.js encodes it, sent with the host's keys. Only plain
 * Backspace and Enter change; with Ctrl or Alt they send what they always did.
 */
export function keyboardInputData(
  data: string,
  modes: Pick<TerminalInputModes, 'backspaceKey' | 'enterKey'>,
): string {
  if (data === '\r') return withEnterKey(data, modes.enterKey);
  if (data === '\x7f' && modes.backspaceKey === 'ctrl-h') return '\b';
  return data;
}

/**
 * What local echo shows for input, as an echoing device would: printable text
 * as typed, Enter as a new line, Backspace as erasing the character before the
 * cursor. Escape sequences (arrows, function keys, Alt combinations, terminal
 * replies) and other control characters, Tab included, are not shown.
 */
export function localEchoText(data: string): string {
  if (data === '\x7f' || data === '\b') return '\b \b';
  if (data.startsWith('\x1b')) return '';
  return data.replace(/\r\n?|\n/g, '\r\n').replace(UNSHOWN_CONTROL, '');
}
