import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SavedScript,
  SavedScriptInput,
  SavedScriptsResponse,
  ScriptRunRequest,
  ScriptRunStatus,
} from '@muxus/shared';
import { apiFetch } from './http.js';
import { showErrorToast } from '../state/toast.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function useSavedScripts() {
  return useQuery({
    queryKey: ['scripts'],
    queryFn: () => apiFetch<SavedScriptsResponse>('/api/scripts'),
  });
}

export function useSaveScript(onSuccess?: (script: SavedScript) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedScriptInput) =>
      apiFetch<SavedScript>('/api/scripts', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(input) }),
    onSuccess: (script) => {
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
      onSuccess?.(script);
    },
    onError: showErrorToast,
  });
}

export function useDeleteScript(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
      onSuccess?.();
    },
    onError: showErrorToast,
  });
}

export function startScriptRun(request: ScriptRunRequest): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/api/script-runs', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

export function scriptRunStatus(id: string, since: number): Promise<ScriptRunStatus> {
  return apiFetch<ScriptRunStatus>(`/api/script-runs/${encodeURIComponent(id)}?since=${since}`);
}

export function cancelScriptRun(id: string): Promise<unknown> {
  return apiFetch(`/api/script-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
}
