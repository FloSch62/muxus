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
  { value: 'ctrl', label: 'Control + left click' },
  { value: 'meta', label: 'Cmd + left click' },
  { value: 'direct', label: 'Direct left click' },
];

/** Mouse gestures that can actually be produced on the current platform. */
export function terminalFileLinkActivationOptions(
  isMac: boolean,
): readonly TerminalFileLinkActivationOption[] {
  return isMac ? MAC_OPTIONS : NON_MAC_OPTIONS;
}

/** Gracefully handle a Cmd preference restored from a macOS backup elsewhere. */
export function terminalFileLinkActivationForPlatform(
  activation: TerminalFileLinkActivation,
  isMac: boolean,
): TerminalFileLinkActivation {
  return activation === 'meta' && !isMac ? 'alt' : activation;
}
