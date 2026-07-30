import { useQuery } from '@tanstack/react-query';
import type { AppLogEntry, AppLogsResponse } from '@muxus/shared';
import { apiFetch } from './http.js';

export function fetchAppLogs(): Promise<AppLogsResponse> {
  return apiFetch<AppLogsResponse>('/api/logs');
}

/** Diagnostic log buffer, polled while the viewer is open. */
export function useAppLogs(enabled: boolean) {
  return useQuery({
    queryKey: ['app-logs'],
    queryFn: fetchAppLogs,
    enabled,
    refetchInterval: 2_000,
  });
}

/** Raise (or restore) the server's log level; idempotent per window. */
export function setDebugLogging(debugEnabled: boolean): Promise<{ debugEnabled: boolean }> {
  return apiFetch<{ debugEnabled: boolean }>('/api/logs/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ debugEnabled }),
  });
}

export function clearAppLogs(): Promise<{ cleared: boolean }> {
  return apiFetch<{ cleared: boolean }>('/api/logs', { method: 'DELETE' });
}

/** One text line per entry, shared by the viewer, copy, and export. */
export function formatLogEntry(entry: AppLogEntry): string {
  const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
  return `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.source.padEnd(6)} ${entry.msg}${context}`;
}
