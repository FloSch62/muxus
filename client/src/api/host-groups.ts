import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OpenSshMetadataPatch,
  SavedHostProfile,
  SavedHostProfilesResponse,
  SshConfigResponse,
} from '@muxus/shared';
import type { FolderMove } from '../components/sidebar/folder-mutations.js';
import { managedHostKey } from '../managed-hosts.js';
import { showToast } from '../state/toast.js';
import { apiFetch } from './http.js';

/** Enough in flight to feel instant, few enough not to stampede the server. */
const CHUNK_SIZE = 8;

export interface FolderMutationResult {
  attempted: number;
  failed: number;
}

/**
 * Apply one folder operation across every host it touches.
 *
 * Looping the per-host metadata hooks would work, but each of those raises its
 * own error toast and invalidation — renaming a 40-host folder over a flaky
 * connection would produce 40 of each. This batches the same PATCH endpoints
 * into a single optimistic update, a single toast, and a single refetch.
 */
export function useApplyFolderMoves() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ moves }: { moves: FolderMove[]; label: string }) => {
      let failed = 0;
      for (let index = 0; index < moves.length; index += CHUNK_SIZE) {
        const chunk = moves.slice(index, index + CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map(patchGroup));
        failed += results.filter((result) => result.status === 'rejected').length;
      }
      return { attempted: moves.length, failed } satisfies FolderMutationResult;
    },
    onMutate: async ({ moves }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['ssh-config'] }),
        queryClient.cancelQueries({ queryKey: ['saved-host-profiles'] }),
      ]);
      const previousConfig = queryClient.getQueryData<SshConfigResponse>(['ssh-config']);
      const previousProfiles = queryClient.getQueryData<SavedHostProfilesResponse>([
        'saved-host-profiles',
      ]);
      const groupByKey = new Map(
        moves.map((move) => [managedHostKey(move.host), move.group ?? undefined]),
      );

      queryClient.setQueryData<SshConfigResponse>(['ssh-config'], (current) => {
        if (!current) return current;
        return {
          ...current,
          hosts: current.hosts.map((host) => {
            const key = `ssh:${host.alias}`;
            if (!groupByKey.has(key)) return host;
            return {
              ...host,
              metadata: {
                profileId: host.metadata?.profileId ?? host.alias,
                connectCount: host.metadata?.connectCount ?? 0,
                ...host.metadata,
                group: groupByKey.get(key),
              },
            };
          }),
        };
      });
      queryClient.setQueryData<SavedHostProfilesResponse>(['saved-host-profiles'], (current) => {
        if (!current) return current;
        return {
          profiles: current.profiles.map((profile) => {
            const key = `profile:${profile.id}`;
            if (!groupByKey.has(key)) return profile;
            return { ...profile, metadata: { ...profile.metadata, group: groupByKey.get(key) } };
          }),
        };
      });
      return { previousConfig, previousProfiles };
    },
    onSuccess: ({ attempted, failed }, { label }) => {
      if (failed === 0) return;
      showToast(
        'error',
        `Moved ${attempted - failed} of ${attempted} hosts — “${label}” is only partly moved.`,
      );
    },
    onError: (_error, _variables, context) => {
      if (context?.previousConfig) queryClient.setQueryData(['ssh-config'], context.previousConfig);
      if (context?.previousProfiles) {
        queryClient.setQueryData(['saved-host-profiles'], context.previousProfiles);
      }
      showToast('error', 'Could not move that folder.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    },
  });
}

function patchGroup({ host, group }: FolderMove): Promise<unknown> {
  const patch: OpenSshMetadataPatch = { group };
  const body = JSON.stringify(patch);
  const init = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body } as const;
  return host.kind === 'ssh'
    ? apiFetch<unknown>(
        `/api/ssh/config/hosts/${encodeURIComponent(host.entry.alias)}/metadata`,
        init,
      )
    : apiFetch<SavedHostProfile>(
        `/api/profiles/${encodeURIComponent(host.entry.id)}/metadata`,
        init,
      );
}
