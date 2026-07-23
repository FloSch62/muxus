import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HostPreviewResponse, HostUpsertRequest } from '@muxus/shared';
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

/** The exact block text a save would write — for the editor's live preview. */
export async function fetchHostPreview(req: HostUpsertRequest): Promise<string> {
  const res = await apiFetch<HostPreviewResponse>('/api/ssh/config/preview', json(req));
  return res.text;
}
