import { useMemo } from 'react';
import { useSavedHostProfiles, useSshConfig } from './api/queries.js';
import { shownCommandButtonGroup } from './command-buttons.js';
import { isTerminalHost } from './host-bulk-edit.js';
import {
  editableManagedHostForProfile,
  managedHostDisplayName,
  type ManagedHost,
} from './managed-hosts.js';
import { usePrefsStore, type CommandButtonGroup } from './state/prefs.js';
import { useTabsStore } from './state/tabs.js';
import { useUiStore } from './state/ui.js';

export interface ActiveCommandButtonGroup {
  groups: readonly CommandButtonGroup[];
  /** The group the bar and the keyboard menu show right now. */
  shownId: string;
  /**
   * The saved terminal host behind the active session, which can be given a
   * group of its own. Only looked up once there is more than one group.
   */
  host?: ManagedHost;
  /** That host's display name. */
  hostName?: string;
  /** The group that host opens, when it names one that exists. */
  hostGroupId?: string;
  /**
   * Show another group. With a host that opens its own group, the choice
   * holds for this session only; otherwise it becomes the group for every
   * session without one.
   */
  select: (groupId: string) => void;
}

/** Which command button group to show for the active session, and how to change it. */
export function useActiveCommandButtonGroup(): ActiveCommandButtonGroup {
  const groups = usePrefsStore((state) => state.commandButtonGroups);
  const selected = usePrefsStore((state) => state.selectedCommandButtonGroup);
  const setPrefs = usePrefsStore((state) => state.set);
  const activeTab = useTabsStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeId),
  );
  const tabId = activeTab?.id;
  const profile = activeTab?.profile ?? null;
  const sessionChoice = useUiStore((state) =>
    tabId ? state.commandButtonGroupByTab[tabId] : undefined,
  );
  const setGroupForTab = useUiStore((state) => state.setCommandButtonGroupForTab);

  // With only the default group no host can open another, so skip the lookups.
  const grouped = groups.length > 1;
  const savedProfileId = profile && profile.kind !== 'local' ? profile.profileId : undefined;
  const { data: sshConfig } = useSshConfig(
    grouped && !savedProfileId && profile?.kind === 'ssh' && profile.useConfig !== false,
  );
  const { data: savedHosts } = useSavedHostProfiles(grouped && !!savedProfileId);
  const host = useMemo(() => {
    if (!grouped || !profile) return undefined;
    const found = editableManagedHostForProfile(
      profile,
      sshConfig?.hosts ?? [],
      savedHosts?.profiles ?? [],
    );
    return found && isTerminalHost(found) ? found : undefined;
  }, [grouped, profile, sshConfig?.hosts, savedHosts?.profiles]);
  const requested = host?.entry.metadata?.commandButtonGroup;
  const hostGroupId =
    requested && groups.some((group) => group.id === requested) ? requested : undefined;

  return {
    groups,
    shownId: shownCommandButtonGroup(groups, {
      session: hostGroupId ? sessionChoice : undefined,
      host: hostGroupId,
      selected,
    }),
    host,
    hostName: host ? managedHostDisplayName(host) : undefined,
    hostGroupId,
    select: (groupId) => {
      if (hostGroupId && tabId) setGroupForTab(tabId, groupId);
      else setPrefs({ selectedCommandButtonGroup: groupId });
    },
  };
}
