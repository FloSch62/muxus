import { useQuery } from '@tanstack/react-query';
import type { AppInfo, ForwardInfo, SftpListResponse, SshConfigResponse, SshKeysResponse } from '@muxus/shared';
import { apiFetch } from './http.js';

export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
  });
}

export function useSshConfig() {
  return useQuery({
    queryKey: ['ssh-config'],
    queryFn: () => apiFetch<SshConfigResponse>('/api/ssh/config'),
    // ~/.ssh/config is the session store; pick up external edits quickly.
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useSshKeys(enabled = true) {
  return useQuery({
    queryKey: ['ssh-keys'],
    queryFn: () => apiFetch<SshKeysResponse>('/api/ssh/keys'),
    enabled,
    staleTime: 30_000,
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
