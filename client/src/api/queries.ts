import { useQuery } from '@tanstack/react-query';
import type {
  AppInfo,
  ConnectionsResponse,
  ForwardInfo,
  SerialPortsResponse,
  SavedHostProfilesResponse,
  SftpListResponse,
  SshConfigResponse,
  SshKeysResponse,
  TunnelsResponse,
} from '@muxus/shared';
import { apiFetch } from './http.js';

export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: () => apiFetch<AppInfo>('/api/app/info'),
    staleTime: Infinity,
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

export function useSshKeys(enabled = true) {
  return useQuery({
    queryKey: ['ssh-keys'],
    queryFn: () => apiFetch<SshKeysResponse>('/api/ssh/keys'),
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

/** Every active forward on every connection (forwarding panel + badge). */
export function useForwards() {
  return useQuery({
    queryKey: ['forwards'],
    queryFn: () => apiFetch<{ forwards: ForwardInfo[] }>('/api/forwards'),
    refetchInterval: 5_000,
  });
}

/** Live SSH transports (connection reuse for tunnels, grouping in the panel). */
export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () => apiFetch<ConnectionsResponse>('/api/connections'),
    refetchInterval: 5_000,
  });
}

/** Saved tunnel definitions. */
export function useTunnels() {
  return useQuery({
    queryKey: ['tunnels'],
    queryFn: () => apiFetch<TunnelsResponse>('/api/tunnels'),
  });
}
