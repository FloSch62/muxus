import { useQuery } from '@tanstack/react-query';
import type { PasswordVaultStatus } from '@muxus/shared';
import { fetchPasswordVaultStatus } from './password-vault.js';

/** Feature-local so password-vault code stays out of the initial bundle. */
export function usePasswordVaultStatus() {
  return useQuery<PasswordVaultStatus>({
    queryKey: ['password-vault'],
    queryFn: fetchPasswordVaultStatus,
  });
}
