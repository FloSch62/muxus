import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/http.js';
import { sendVaultSecret } from './api/password-vault.js';
import { promptForText } from './state/dialogs.js';
import { showErrorToast, showToast } from './state/toast.js';
import { liveSecretTerminalIds } from './vault-secrets.js';

/** Answers that a master password can resolve. */
const UNLOCK_CODES = new Set([
  'vault-locked',
  'vault-automatic-access-unavailable',
  'invalid-master-password',
]);

/**
 * Ask the backend to type a secret into a tab and the panes mirroring it,
 * asking for the master password while the vault's prompt policy wants one.
 * Resolves true once the secret was typed.
 */
export async function sendSecretToTab(
  tabId: string,
  secret: { id: string; name: string },
  enter: boolean,
  queryClient?: QueryClient,
): Promise<boolean> {
  const terminalIds = liveSecretTerminalIds(tabId);
  if (terminalIds.length === 0) {
    showToast('warning', 'The active terminal is not connected.');
    return false;
  }
  let masterPassword: string | undefined;
  let problem: string | undefined;
  for (;;) {
    try {
      await sendVaultSecret(secret.id, {
        terminalIds,
        enter,
        ...(masterPassword !== undefined ? { masterPassword } : {}),
      });
      // A startup-policy vault stays unlocked once the master password was given.
      if (masterPassword !== undefined) {
        void queryClient?.invalidateQueries({ queryKey: ['password-vault'] });
      }
      return true;
    } catch (error) {
      const code = error instanceof ApiError ? error.body?.code : undefined;
      if (code && UNLOCK_CODES.has(code)) {
        if (code === 'invalid-master-password') problem = 'The master password is incorrect.';
        const answer = await promptForText({
          title: 'Unlock password vault',
          description: problem ?? `Enter the master password to send “${secret.name}”.`,
          label: 'Master password',
          masked: true,
          confirmLabel: 'Send',
        });
        if (answer === null) return false;
        masterPassword = answer;
        continue;
      }
      if (code === 'vault-secret-missing') {
        showToast('error', `“${secret.name}” is no longer in the password vault.`);
        void queryClient?.invalidateQueries({ queryKey: ['password-vault'] });
      } else if (code === 'terminal-unavailable') {
        showToast('warning', 'The active terminal is not connected.');
      } else {
        showErrorToast(error);
      }
      return false;
    }
  }
}
