import type { TerminalTab } from '../state/tabs.js';
import { terminalHandle } from './terminal-registry.js';

/** Serial, Telnet and SSH sessions have a line to send BREAK on; shells and desktops do not. */
export function supportsBreak(tab: TerminalTab | undefined): boolean {
  const kind = tab?.profile?.kind;
  return kind === 'serial' || kind === 'telnet' || kind === 'ssh';
}

/**
 * Whether the session is attached. An SSH console that has printed nothing
 * yet still counts: a silent console is exactly when BREAK is wanted.
 */
export function canSendBreak(tab: TerminalTab | undefined): boolean {
  if (!tab || !supportsBreak(tab)) return false;
  return tab.status === 'connected' || (tab.status === 'connecting' && !!tab.connId);
}

/** BREAK goes to this one session only; multi-execution never mirrors it. */
export function sendBreak(tab: TerminalTab | undefined): boolean {
  if (!canSendBreak(tab)) return false;
  return terminalHandle(tab!.id)?.sendBreak() ?? false;
}
