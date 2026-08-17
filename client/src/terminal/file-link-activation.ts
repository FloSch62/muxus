import type { TerminalFileLinkActivation } from '../state/prefs.js';

export interface TerminalFileLinkActivationOption {
  value: TerminalFileLinkActivation;
  label: string;
}

const NON_MAC_OPTIONS: readonly TerminalFileLinkActivationOption[] = [
  { value: 'alt', label: 'Alt + left click' },
  { value: 'ctrl', label: 'Ctrl + left click' },
  { value: 'direct', label: 'Direct left click' },
];

const MAC_OPTIONS: readonly TerminalFileLinkActivationOption[] = [
  { value: 'alt', label: 'Option + left click' },
  { value: 'meta', label: 'Cmd + left click' },
  { value: 'direct', label: 'Direct left click' },
];

/** Mouse gestures that can actually be produced on the current platform. */
export function terminalFileLinkActivationOptions(
  isMac: boolean,
): readonly TerminalFileLinkActivationOption[] {
  return isMac ? MAC_OPTIONS : NON_MAC_OPTIONS;
}

/** Map a cross-platform backup to a gesture that is safe on this platform. */
export function terminalFileLinkActivationForPlatform(
  activation: TerminalFileLinkActivation,
  isMac: boolean,
): TerminalFileLinkActivation {
  if (activation === 'meta' && !isMac) return 'alt';
  if (activation === 'ctrl' && isMac) return 'meta';
  return activation;
}

/** Match only the configured left-click gesture, leaving every other click to the terminal. */
export function terminalLinkActivationMatches(
  event: Pick<MouseEvent, 'altKey' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  activation: TerminalFileLinkActivation,
): boolean {
  if (event.button !== 0 || event.shiftKey) return false;
  if (activation === 'direct') return !event.altKey && !event.ctrlKey && !event.metaKey;
  if (activation === 'alt') return event.altKey && !event.ctrlKey && !event.metaKey;
  if (activation === 'ctrl') return event.ctrlKey && !event.altKey && !event.metaKey;
  return event.metaKey && !event.altKey && !event.ctrlKey;
}

/** Keep xterm's Alt cursor movement from competing with an Alt file-open gesture. */
export function altClickMovesCursorForFileLinkActivation(
  activation: TerminalFileLinkActivation,
  isMac: boolean,
): boolean {
  return terminalFileLinkActivationForPlatform(activation, isMac) !== 'alt';
}
