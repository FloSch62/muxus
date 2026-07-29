import { describe, expect, it } from 'vitest';
import type { PasswordVaultStatus } from '@muxus/shared';
import { shouldDelayWorkspaceRestoreForVault } from '../../../client/src/password-vault-startup.js';

const status = (
  overrides: Partial<PasswordVaultStatus> = {},
): PasswordVaultStatus => ({
  configured: true,
  unlockPolicy: 'startup',
  locked: true,
  osKeyStoreAvailable: true,
  credentialCount: 1,
  credentials: [],
  ...overrides,
});

describe('password-vault startup coordination', () => {
  it('delays restored sessions while the startup-policy vault is locked', () => {
    expect(
      shouldDelayWorkspaceRestoreForVault({
        status: status(),
        pending: false,
        failed: false,
      }),
    ).toBe(true);
  });

  it('waits for the status request before restoring sessions', () => {
    expect(
      shouldDelayWorkspaceRestoreForVault({
        status: undefined,
        pending: true,
        failed: false,
      }),
    ).toBe(true);
  });

  it('continues after unlock or when no startup prompt applies', () => {
    for (const current of [
      status({ locked: false }),
      status({ unlockPolicy: 'credential' }),
      status({ unlockPolicy: 'never' }),
      status({ configured: false, unlockPolicy: undefined, locked: false }),
    ]) {
      expect(
        shouldDelayWorkspaceRestoreForVault({
          status: current,
          pending: false,
          failed: false,
        }),
      ).toBe(false);
    }
  });

  it('does not let a failed status request block workspace startup', () => {
    expect(
      shouldDelayWorkspaceRestoreForVault({
        status: undefined,
        pending: false,
        failed: true,
      }),
    ).toBe(false);
  });
});
