import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  FolderAuthSettings,
  FolderSettingsRecord,
  FolderSettingsResponse,
  LoginSequence,
  SavedHostProfilesResponse,
  SshConfigResponse,
} from '@muxus/shared';
import { isDescendantPath, isSamePath } from '../host-tree.js';
import type { LoginSequenceOwner } from '../login-sequence.js';
import { showToast } from '../state/toast.js';
import { apiFetch } from './http.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Shared per-folder SSH credential defaults (Termius-style group auth). */
export function useFolderSettings(enabled = true) {
  return useQuery({
    queryKey: ['folder-settings'],
    queryFn: () => apiFetch<FolderSettingsResponse>('/api/folders/settings'),
    enabled,
    staleTime: 5_000,
  });
}

/** The folder's own settings record, matched case-insensitively. */
export function folderSettingsForPath(
  folders: readonly FolderSettingsRecord[] | undefined,
  path: string,
): FolderSettingsRecord | undefined {
  return folders?.find((folder) => isSamePath(folder.path, path));
}

/** Whether the folder or anything nested inside it stores credentials. */
export function hasFolderSettingsUnder(
  folders: readonly FolderSettingsRecord[] | undefined,
  path: string,
): boolean {
  return (folders ?? []).some(
    (folder) => isSamePath(folder.path, path) || isDescendantPath(folder.path, path),
  );
}

export interface SaveFolderSettingsInput {
  path: string;
  auth: FolderAuthSettings;
  /** A new password to store, null to remove the stored one, undefined to keep. */
  password?: string | null;
  /** Required by the server while the password vault is locked. */
  masterPassword?: string;
  /** The folder's login sequence; null clears it, undefined keeps it. */
  loginSequence?: LoginSequence | null;
}

export function useSaveFolderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, auth, password, masterPassword, loginSequence }: SaveFolderSettingsInput) => {
      await apiFetch<{ folder: FolderSettingsRecord | null }>('/api/folders/settings', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path, auth, ...(loginSequence !== undefined ? { loginSequence } : {}) }),
      });
      if (typeof password === 'string') {
        await apiFetch<{ folder: FolderSettingsRecord }>('/api/folders/settings/password', {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            path,
            password,
            ...(masterPassword ? { masterPassword } : {}),
          }),
        });
      } else if (password === null) {
        await apiFetch<{ deleted: boolean }>(
          `/api/folders/settings/password?path=${encodeURIComponent(path)}`,
          { method: 'DELETE' },
        );
      }
    },
    onError: (error) => {
      showToast(
        'error',
        error instanceof Error && error.message
          ? `Could not save the folder credentials: ${error.message}`
          : 'Could not save the folder credentials.',
      );
    },
    onSettled: () => invalidateFolderSettings(queryClient),
  });
}

/** Carry folder credentials along with a folder rename or re-parent. */
export function useMoveFolderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      apiFetch<{ moved: number; destinationPreserved: boolean }>('/api/folders/settings/move', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ from, to }),
      }),
    onError: (_error, { to }) => {
      showToast(
        'error',
        `The shared credentials did not follow the folder — edit “${to}” to restore them.`,
      );
    },
    onSettled: () => invalidateFolderSettings(queryClient),
  });
}

/** Deleting a folder removes its credentials; nested ones move up a level. */
export function useDeleteFolderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      apiFetch<{ removed: number }>(
        `/api/folders/settings?path=${encodeURIComponent(path)}`,
        { method: 'DELETE' },
      ),
    onSettled: () => invalidateFolderSettings(queryClient),
  });
}

/** Every host and folder that sets its own login sequence, for checks before a secret is deleted. */
export async function fetchLoginSequenceOwners(): Promise<LoginSequenceOwner[]> {
  const [config, saved, folders] = await Promise.all([
    apiFetch<SshConfigResponse>('/api/ssh/config'),
    apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    apiFetch<FolderSettingsResponse>('/api/folders/settings'),
  ]);
  return [
    ...config.hosts.map((host) => ({
      label: host.metadata?.displayName ?? host.alias,
      loginSequence: host.metadata?.loginSequence,
    })),
    ...saved.profiles.map((profile) => ({
      label: profile.name,
      loginSequence: profile.metadata.loginSequence,
    })),
    ...folders.folders.map((folder) => ({ label: folder.path, loginSequence: folder.loginSequence })),
  ];
}

function invalidateFolderSettings(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['folder-settings'] });
  // Folder defaults feed the resolved values in the host list, and folder
  // passwords appear as vault credentials.
  void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
  void queryClient.invalidateQueries({ queryKey: ['password-vault'] });
}
