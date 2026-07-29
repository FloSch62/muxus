import type { PasswordVaultStatus } from '@muxus/shared';
import { apiFetch } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchPasswordVaultStatus(): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault');
}

export function createPasswordVault(
  password: string,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault/create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
}

export function repairPasswordVaultAutomaticAccess(
  masterPassword: string,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>(
    '/api/password-vault/repair-automatic-access',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ masterPassword }),
    },
  );
}

export function revealSavedPassword(
  id: string,
  masterPassword: string,
): Promise<{ password: string }> {
  return apiFetch<{ password: string }>(
    `/api/password-vault/credentials/${encodeURIComponent(id)}/reveal`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ masterPassword }),
    },
  );
}

export function updateSavedPassword(
  id: string,
  masterPassword: string,
  password: string,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>(
    `/api/password-vault/credentials/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ masterPassword, password }),
    },
  );
}

export function changeMasterPassword(
  currentPassword: string,
  nextPassword: string,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>(
    '/api/password-vault/change-master-password',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ currentPassword, nextPassword }),
    },
  );
}

export function forgetSavedPassword(
  id: string,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(
    `/api/password-vault/credentials/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export function deletePasswordVault(): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault', {
    method: 'DELETE',
  });
}
