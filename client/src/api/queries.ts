import { useQuery } from '@tanstack/react-query';
import type { AppInfo, ForwardInfo, SftpListResponse, SshConfigResponse } from '@muxus/shared';
import { apiFetch } from './http.js';

export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
  });
}

export function useSshConfigHosts() {
  return useQuery({
    queryKey: ['ssh-config-hosts'],
    queryFn: () => apiFetch<SshConfigResponse>('/api/ssh/config-hosts'),
    // The config rarely changes mid-session; a manual refresh re-reads it.
    staleTime: 60_000,
  });
}

export function useSftpList(connId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ['sftp-list', connId, path],
    queryFn: () => apiFetch<SftpListResponse>(`/api/sftp/${connId}/list?path=${encodeURIComponent(path ?? '.')}`),
    enabled: !!connId && !!path,
  });
}

export function useSftpHome(connId: string | undefined) {
  return useQuery({
    queryKey: ['sftp-home', connId],
    queryFn: () => apiFetch<{ path: string }>(`/api/sftp/${connId}/home`),
    enabled: !!connId,
    staleTime: Infinity,
  });
}

export function useForwards(connId: string | undefined) {
  return useQuery({
    queryKey: ['forwards', connId],
    queryFn: () => apiFetch<{ forwards: ForwardInfo[] }>(`/api/forwards?connId=${encodeURIComponent(connId ?? '')}`),
    enabled: !!connId,
    refetchInterval: 5_000,
  });
}
