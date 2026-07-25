import { useMemo } from 'react';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import type { ManagedHost } from '../../managed-hosts.js';

/**
 * Every host from both sources, unfiltered and ungrouped.
 *
 * Folder operations must be planned against this rather than against the
 * sidebar's filtered tree: rewriting a path from a filtered list would leave
 * every host the filter hid behind on the old path, splitting one folder in two.
 */
export function useAllManagedHosts(): ManagedHost[] {
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  return useMemo(
    () => [
      ...(config?.hosts ?? []).map((entry) => ({ kind: 'ssh' as const, entry })),
      ...(savedData?.profiles ?? []).map((entry) => ({ kind: 'profile' as const, entry })),
    ],
    [config?.hosts, savedData?.profiles],
  );
}
