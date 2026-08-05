import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  HostPreviewResponse,
  HostUpsertRequest,
  OpenSshMetadataPatch,
  OpenSshProfileMetadata,
  SshConfigResponse,
} from '@muxus/shared';
import { apiFetch } from './http.js';
import { showErrorToast } from '../state/toast.js';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Create or update a Host block in ~/.ssh/config. */
export function useUpsertHost(onSuccess?: (req: HostUpsertRequest) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: HostUpsertRequest) => apiFetch<{ file: string }>('/api/ssh/config/hosts', json(req)),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      onSuccess?.(req);
    },
    onError: showErrorToast,
  });
}

/** Delete a Host block from ~/.ssh/config. */
export function useDeleteHost(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alias: string) => apiFetch<{ ok: boolean }>(`/api/ssh/config/hosts/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      onSuccess?.();
    },
    onError: showErrorToast,
  });
}

/** Update Muxus-owned metadata without rewriting the OpenSSH Host block. */
export function useUpdateSshMetadata(onSuccess?: (metadata: OpenSshProfileMetadata) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ alias, patch }: { alias: string; patch: OpenSshMetadataPatch }) =>
      apiFetch<OpenSshProfileMetadata>(
        `/api/ssh/config/hosts/${encodeURIComponent(alias)}/metadata`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      ),
    onMutate: async ({ alias, patch }) => {
      await queryClient.cancelQueries({ queryKey: ['ssh-config'] });
      const previous = queryClient.getQueryData<SshConfigResponse>(['ssh-config']);
      queryClient.setQueryData<SshConfigResponse>(['ssh-config'], (current) => {
        if (!current) return current;
        return {
          ...current,
          hosts: current.hosts.map((host) => {
            if (host.alias !== alias) return host;
            const metadata: OpenSshProfileMetadata = {
              profileId: host.metadata?.profileId ?? host.alias,
              connectCount: host.metadata?.connectCount ?? 0,
              ...host.metadata,
              ...(patch.displayName !== undefined ? { displayName: patch.displayName ?? undefined } : {}),
              ...(patch.group !== undefined ? { group: patch.group ?? undefined } : {}),
              ...(patch.color !== undefined ? { color: patch.color ?? undefined } : {}),
              ...(patch.icon !== undefined ? { icon: patch.icon ?? undefined } : {}),
              ...(patch.keywordHighlights !== undefined
                ? { keywordHighlights: patch.keywordHighlights ?? undefined }
                : {}),
              ...(patch.disableSftp !== undefined
                ? { disableSftp: patch.disableSftp || undefined }
                : {}),
              ...(patch.consoleCompatibility !== undefined
                ? { consoleCompatibility: patch.consoleCompatibility || undefined }
                : {}),
            };
            return { ...host, metadata };
          }),
        };
      });
      return { previous };
    },
    onSuccess: (metadata) => {
      onSuccess?.(metadata);
    },
    onError: (error, _request, context) => {
      if (context?.previous) queryClient.setQueryData(['ssh-config'], context.previous);
      showErrorToast(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
    },
  });
}

/** Persist and optimistically display the order of one complete host group. */
/** The exact block text a save would write — for the editor's live preview. */
export async function fetchHostPreview(req: HostUpsertRequest): Promise<string> {
  const res = await apiFetch<HostPreviewResponse>('/api/ssh/config/preview', json(req));
  return res.text;
}
