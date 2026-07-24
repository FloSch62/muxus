import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  HostOrderRequest,
  ManagedHostRef,
  SavedHostProfilesResponse,
  SshConfigResponse,
} from '@muxus/shared';
import { managedHostRefKey } from '../managed-hosts.js';
import { showErrorToast } from '../state/toast.js';
import { apiFetch } from './http.js';

/**
 * Persist one visual sidebar order across both host sources, optimistically
 * bumping sortOrder in the ssh-config and saved-host caches so rows settle
 * in place before the server confirms.
 */
export function useReorderManagedHosts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hosts: ManagedHostRef[]) =>
      apiFetch<{ ok: boolean }>('/api/hosts/order', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hosts } satisfies HostOrderRequest),
      }),
    onMutate: async (hosts) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['ssh-config'] }),
        queryClient.cancelQueries({ queryKey: ['saved-host-profiles'] }),
      ]);
      const previousConfig = queryClient.getQueryData<SshConfigResponse>(['ssh-config']);
      const previousProfiles = queryClient.getQueryData<SavedHostProfilesResponse>([
        'saved-host-profiles',
      ]);
      const order = new Map(hosts.map((ref, index) => [managedHostRefKey(ref), index]));
      queryClient.setQueryData<SshConfigResponse>(['ssh-config'], (current) => {
        if (!current) return current;
        return {
          ...current,
          hosts: current.hosts.map((host) => {
            const sortOrder = order.get(`ssh:${host.alias}`);
            if (sortOrder === undefined) return host;
            return {
              ...host,
              metadata: {
                profileId: host.metadata?.profileId ?? host.alias,
                favorite: host.metadata?.favorite ?? false,
                connectCount: host.metadata?.connectCount ?? 0,
                ...host.metadata,
                sortOrder,
              },
            };
          }),
        };
      });
      queryClient.setQueryData<SavedHostProfilesResponse>(['saved-host-profiles'], (current) => {
        if (!current) return current;
        return {
          profiles: current.profiles.map((profile) => {
            const sortOrder = order.get(`profile:${profile.id}`);
            if (sortOrder === undefined) return profile;
            return { ...profile, metadata: { ...profile.metadata, sortOrder } };
          }),
        };
      });
      return { previousConfig, previousProfiles };
    },
    onError: (error, _hosts, context) => {
      if (context?.previousConfig) queryClient.setQueryData(['ssh-config'], context.previousConfig);
      if (context?.previousProfiles) {
        queryClient.setQueryData(['saved-host-profiles'], context.previousProfiles);
      }
      showErrorToast(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    },
  });
}
