import type {
  PasswordVaultStatus,
  PasswordVaultUnlockPolicy,
  SendVaultSecretRequest,
  SendVaultSecretResult,
  VaultSecretInput,
  VaultSecretSaveResult,
} from '@muxus/shared';
import { apiFetch } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchPasswordVaultStatus(): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault');
}

export function createPasswordVault(
  password: string,
  unlockPolicy: PasswordVaultUnlockPolicy,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault/create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password, unlockPolicy }),
  });
}

export function unlockPasswordVault(
  masterPassword: string,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>('/api/password-vault/unlock', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ masterPassword }),
  });
}

export function changePasswordVaultUnlockPolicy(
  masterPassword: string,
  unlockPolicy: PasswordVaultUnlockPolicy,
): Promise<PasswordVaultStatus> {
  return apiFetch<PasswordVaultStatus>(
    '/api/password-vault/unlock-policy',
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ masterPassword, unlockPolicy }),
    },
  );
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

export function createVaultSecret(input: VaultSecretInput): Promise<VaultSecretSaveResult> {
  return apiFetch<VaultSecretSaveResult>('/api/password-vault/secrets', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function updateVaultSecret(
  id: string,
  input: VaultSecretInput,
): Promise<VaultSecretSaveResult> {
  return apiFetch<VaultSecretSaveResult>(
    `/api/password-vault/secrets/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
  );
}

/** Have the backend type a secret into live sessions; the value never comes back. */
export function sendVaultSecret(
  id: string,
  request: SendVaultSecretRequest,
): Promise<SendVaultSecretResult> {
  return apiFetch<SendVaultSecretResult>(
    `/api/password-vault/secrets/${encodeURIComponent(id)}/send`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    },
  );
}
