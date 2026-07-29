import type { PasswordVaultStatus } from '@muxus/shared';

/**
 * Restored remote sessions must not dial while the startup-policy prompt is
 * unresolved. Otherwise the session and the app-level prompt both ask for the
 * same master password.
 */
export function shouldDelayWorkspaceRestoreForVault({
  status,
  pending,
  failed,
}: {
  status: PasswordVaultStatus | undefined;
  pending: boolean;
  failed: boolean;
}): boolean {
  if (failed) return false;
  if (pending || !status) return true;
  return (
    status.configured &&
    status.unlockPolicy === 'startup' &&
    status.locked
  );
}
