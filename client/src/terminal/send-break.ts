import type { TerminalTab } from '../state/tabs.js';
import { terminalHandle } from './terminal-registry.js';

/**
 * Serial, Telnet and SSH sessions are a line to a device that text can be
 * typed into; shells and desktops are not.
 */
export function isLineSession(tab: TerminalTab | undefined): boolean {
  const kind = tab?.profile?.kind;
  return kind === 'serial' || kind === 'telnet' || kind === 'ssh';
}

/** Serial and Telnet lines carry BREAK; SSH sessions, shells and desktops do not. */
export function supportsBreak(tab: TerminalTab | undefined): boolean {
  const kind = tab?.profile?.kind;
  return kind === 'serial' || kind === 'telnet';
}

/**
 * Whether the session is attached. An SSH console that has printed nothing
 * yet still counts: a silent console is exactly when a file is sent to it.
 */
export function sessionAttached(tab: TerminalTab | undefined): boolean {
  if (!tab || !isLineSession(tab)) return false;
  return tab.status === 'connected' || (tab.status === 'connecting' && !!tab.connId);
}

export function canSendBreak(tab: TerminalTab | undefined): boolean {
  return supportsBreak(tab) && sessionAttached(tab);
}

/** BREAK goes to this one session only; multi-execution never mirrors it. */
export function sendBreak(tab: TerminalTab | undefined): boolean {
  if (!canSendBreak(tab)) return false;
  return terminalHandle(tab!.id)?.sendBreak() ?? false;
}
