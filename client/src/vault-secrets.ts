import type { QueryClient } from '@tanstack/react-query';
import type { PasswordVaultSecret, PasswordVaultStatus } from '@muxus/shared';
import {
  activateCommandButton,
  commandButtonLabel,
  isSecretCommandButton,
} from './command-buttons.js';
import { multiExecMirrorTabIds } from './state/multi-exec.js';
import type { CommandButton } from './state/prefs.js';
import { isMultiExecTarget, useTabsStore, type TerminalTab } from './state/tabs.js';
import { terminalHandle } from './terminal/terminal-registry.js';

const SEARCH_WORD_SEPARATOR = /\s+/;

export function findVaultSecret(
  status: PasswordVaultStatus | undefined,
  secretId: string,
): PasswordVaultSecret | undefined {
  return status?.secrets.find((secret) => secret.id === secretId);
}

/**
 * Whether a saved reference has lost its secret. Unknown (undefined) until
 * the vault status has loaded, so nothing is marked missing prematurely.
 */
export function vaultSecretMissing(
  status: PasswordVaultStatus | undefined,
  secretId: string,
): boolean | undefined {
  if (!status) return undefined;
  return !findVaultSecret(status, secretId);
}

/** Saved commands that type this secret, which lose it when it is deleted. */
export function commandButtonsUsingSecret(
  buttons: readonly CommandButton[],
  secretId: string,
): CommandButton[] {
  return buttons.filter((button) => button.secretId === secretId);
}

/** Match every search word against a secret's name or user name. */
export function filterVaultSecrets(
  secrets: readonly PasswordVaultSecret[],
  query: string,
): readonly PasswordVaultSecret[] {
  const words = query.trim().toLowerCase().split(SEARCH_WORD_SEPARATOR).filter(Boolean);
  if (words.length === 0) return secrets;
  return secrets.filter((secret) => {
    const searchable = `${secret.name} ${secret.username ?? ''}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

/**
 * Backend terminal ids a secret typed into `tabId` goes to: that session,
 * then every connected session multi-execution mirrors it into.
 */
export function secretTerminalIds(
  tabId: string,
  tabs: readonly TerminalTab[],
  mirrorTabIds: readonly string[],
): string[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ids: string[] = [];
  for (const id of [tabId, ...mirrorTabIds]) {
    const tab = byId.get(id);
    if (!tab || !isMultiExecTarget(tab) || !tab.terminalId) {
      if (id === tabId) return [];
      continue;
    }
    if (!ids.includes(tab.terminalId)) ids.push(tab.terminalId);
  }
  return ids;
}

/** The backend terminal ids for the tab and its mirrored panes, from the live stores. */
export function liveSecretTerminalIds(tabId: string): string[] {
  return secretTerminalIds(tabId, useTabsStore.getState().tabs, multiExecMirrorTabIds(tabId));
}

/**
 * Type a named secret into a tab (and the panes mirroring it). The backend
 * types the value, so it never reaches this window. False when the tab is
 * not a connected terminal; anything else is reported by the sender.
 */
export function typeSecretIntoTab(
  tabId: string | null | undefined,
  secret: { id: string; name: string },
  enter: boolean,
  queryClient?: QueryClient,
): boolean {
  const terminal = terminalHandle(tabId);
  if (!tabId || !terminal || liveSecretTerminalIds(tabId).length === 0) return false;
  // The sender, with its master-password prompt, loads on first use.
  void import('./vault-secret-send.js')
    .then(({ sendSecretToTab }) => sendSecretToTab(tabId, secret, enter, queryClient))
    .finally(() => terminal.focus());
  return true;
}

/** Run a saved command in a tab: its text through the terminal, or its secret through the backend. */
export function runCommandButton(
  tabId: string | null | undefined,
  button: CommandButton,
  options: { secretName?: string; queryClient?: QueryClient } = {},
): boolean {
  if (!isSecretCommandButton(button)) {
    return activateCommandButton(terminalHandle(tabId), button);
  }
  return typeSecretIntoTab(
    tabId,
    { id: button.secretId, name: options.secretName ?? commandButtonLabel(button) },
    button.sendEnter,
    options.queryClient,
  );
}
