import { useMemo } from 'react';
import {
  queryOptions,
  useInfiniteQuery,
  useQueries,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AppInfo,
  ConnectionsResponse,
  ForwardInfo,
  SerialPortsResponse,
  SavedHostProfilesResponse,
  SessionHistoryResponse,
  SessionHistoryStorageStatus,
  SessionLogDetail,
  SessionLogFileStatus,
  SessionLoggingPolicy,
  SftpListResponse,
  SshConfigResponse,
  SshKeysResponse,
  TunnelsResponse,
  WslDistributionsResponse,
} from '@muxus/shared';
import { apiFetch } from './http.js';

export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
  });
}

export function useWslDistributions(enabled = true) {
  return useQuery({
    queryKey: ['wsl-distributions'],
    queryFn: () => apiFetch<WslDistributionsResponse>('/api/local-shells/wsl'),
    enabled,
    // A distribution installed while Muxus runs appears once the window is
    // focused again.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useSshConfig(enabled = true) {
  return useQuery({
    queryKey: ['ssh-config'],
    queryFn: () => apiFetch<SshConfigResponse>('/api/ssh/config'),
    enabled,
    // OpenSSH config remains the live source for connection details; pick up
    // external edits quickly while the server overlays Muxus-owned metadata.
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useSshKeys(enabled = true, identityAgent?: string) {
  const query = identityAgent === undefined
    ? ''
    : `?identityAgent=${encodeURIComponent(identityAgent)}`;
  return useQuery({
    queryKey: ['ssh-keys', identityAgent ?? null],
    queryFn: () => apiFetch<SshKeysResponse>(`/api/ssh/keys${query}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useSerialPorts(enabled = true) {
  return useQuery({
    queryKey: ['serial-ports'],
    queryFn: () => apiFetch<SerialPortsResponse>('/api/serial/ports'),
    enabled,
    staleTime: 5_000,
  });
}

export function useSavedHostProfiles(enabled = true) {
  return useQuery({
    queryKey: ['saved-host-profiles'],
    queryFn: () => apiFetch<SavedHostProfilesResponse>('/api/profiles'),
    enabled,
    staleTime: 5_000,
  });
}

export function useSftpList(connId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ['sftp-list', connId, path],
    queryFn: () => apiFetch<SftpListResponse>(`/api/sftp/${connId}/list?path=${encodeURIComponent(path ?? '.')}`),
    enabled: !!connId && !!path,
  });
}

/**
 * What the server holds right now, which it only tells when asked. A cached
 * answer is never shown as it is: whatever shows this asks again the moment it
 * appears and when the window comes back to the front. The poll only covers
 * what changes in between, from outside this window.
 */
const LIVE_STATE = { staleTime: 0, refetchOnWindowFocus: true } as const;
const LIVE_STATE_POLL_MS = 5_000;
const FORWARDS_SETTLING_POLL_MS = 1_000;

/**
 * How soon to ask for the forwards again. One on its way up or back is about
 * to change state, so it is followed closely until it has settled.
 */
export function forwardsPollInterval(
  forwards: readonly Pick<ForwardInfo, 'status'>[] | undefined,
): number {
  const settling = forwards?.some(
    (forward) => forward.status === 'starting' || forward.status === 'reconnecting',
  );
  return settling ? FORWARDS_SETTLING_POLL_MS : LIVE_STATE_POLL_MS;
}

export const forwardsQuery = queryOptions({
  queryKey: ['forwards'],
  queryFn: () => apiFetch<{ forwards: ForwardInfo[] }>('/api/forwards'),
  ...LIVE_STATE,
});

export const connectionsQuery = queryOptions({
  queryKey: ['connections'],
  queryFn: () => apiFetch<ConnectionsResponse>('/api/connections'),
  ...LIVE_STATE,
});

export const tunnelsQuery = queryOptions({
  queryKey: ['tunnels'],
  queryFn: () => apiFetch<TunnelsResponse>('/api/tunnels'),
  // Another window may have saved or deleted one since this one last looked.
  staleTime: 0,
});

/** Every active forward on every connection (forwarding panel + badge). */
export function useForwards() {
  return useQuery({
    ...forwardsQuery,
    refetchInterval: (query) => forwardsPollInterval(query.state.data?.forwards),
  });
}

/** Live SSH transports (connection reuse for tunnels, grouping in the panel). */
export function useConnections() {
  return useQuery({ ...connectionsQuery, refetchInterval: LIVE_STATE_POLL_MS });
}

/** Saved tunnel definitions. */
export function useTunnels() {
  return useQuery(tunnelsQuery);
}

export interface SessionHistoryFilters {
  host?: string;
  kind?: 'ssh' | 'local' | 'serial' | 'telnet';
  startedAfter?: string;
  startedBefore?: string;
}

const NO_HISTORY_FILTERS: SessionHistoryFilters = {};

export function useSessionHistory(
  query: string,
  filters: SessionHistoryFilters = NO_HISTORY_FILTERS,
  enabled = true,
) {
  const result = useInfiniteQuery({
    queryKey: ['session-history', query, filters],
    initialPageParam: undefined as string | undefined,
    enabled,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ query, limit: '50' });
      if (filters.host) params.set('host', filters.host);
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.startedAfter) params.set('startedAfter', filters.startedAfter);
      if (filters.startedBefore) params.set('startedBefore', filters.startedBefore);
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch<SessionHistoryResponse>(
        `/api/session-history?${params.toString()}`,
      );
    },
    getNextPageParam: (page) => page.nextCursor,
    // Keep the newest page live, but never re-run every old cursor page on a
    // timer after the user has paged deep into history.
    refetchInterval: (queryState) =>
      (queryState.state.data?.pages.length ?? 0) <= 1 ? 5_000 : false,
  });
  const data = useMemo(
    () =>
      result.data
        ? {
            sessions: result.data.pages.flatMap((page) => page.sessions),
            nextCursor: result.data.pages.at(-1)?.nextCursor,
          }
        : undefined,
    [result.data],
  );
  return {
    ...result,
    data,
  };
}

export function useSessionLog(id: string | undefined, matchQuery = '') {
  return useQuery({
    queryKey: ['session-history', 'detail', id, matchQuery],
    queryFn: () =>
      apiFetch<SessionLogDetail>(
        `/api/session-history/${id}` +
          (matchQuery ? `?query=${encodeURIComponent(matchQuery)}` : ''),
      ),
    enabled: !!id,
  });
}

function sessionLoggingPolicyQuery(profileKey: string) {
  return {
    queryKey: ['session-logging-policy', profileKey],
    queryFn: () =>
      apiFetch<SessionLoggingPolicy>(
        `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`,
      ),
  };
}

export function useSessionLoggingPolicy(profileKey: string, enabled = true) {
  return useQuery({ ...sessionLoggingPolicyQuery(profileKey), enabled });
}

/** Module-level so the combined map only changes when a policy does. */
function policiesByKey(
  results: ReadonlyArray<UseQueryResult<SessionLoggingPolicy>>,
): ReadonlyMap<string, SessionLoggingPolicy> {
  return new Map(
    results.flatMap((result) => (result.data ? [[result.data.profileKey, result.data] as const] : [])),
  );
}

/** Several hosts' policies at once, by profile key; each joins the map as it arrives. */
export function useSessionLoggingPolicies(
  profileKeys: readonly string[],
): ReadonlyMap<string, SessionLoggingPolicy> {
  return useQueries({
    queries: profileKeys.map(sessionLoggingPolicyQuery),
    combine: policiesByKey,
  });
}

export function useSessionHistoryStorage() {
  return useQuery({
    queryKey: ['session-history-storage'],
    queryFn: () =>
      apiFetch<SessionHistoryStorageStatus>('/api/session-history/storage'),
    refetchInterval: 15_000,
  });
}

export function useSessionLogFiles() {
  return useQuery({
    queryKey: ['session-log-files'],
    queryFn: () => apiFetch<SessionLogFileStatus>('/api/session-history/log-files'),
  });
}
