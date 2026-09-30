import { useMemo } from 'react';
import { useAppInfo, useWslDistributions } from './api/queries.js';
import {
  newLocalShellProfileId,
  opensWslDistribution,
  wslShellProfiles,
} from './local-shell-profile.js';
import { usePrefsStore, type LocalShellProfileConfig } from './state/prefs.js';

const NO_PROFILES: LocalShellProfileConfig[] = [];

/** Installed WSL distributions to offer beside the saved local shell
 * profiles; empty unless the server runs on Windows and the list is enabled. */
export function useWslShellProfiles(): LocalShellProfileConfig[] {
  const platform = useAppInfo().data?.platform;
  const enabled = usePrefsStore((state) => state.showWslDistributions);
  const saved = usePrefsStore((state) => state.localShellProfiles);
  const { data } = useWslDistributions(enabled && platform === 'win32');
  const distributions = data?.distributions;
  return useMemo(
    () =>
      enabled && distributions?.length ? wslShellProfiles(distributions, saved) : NO_PROFILES,
    [distributions, enabled, saved],
  );
}

/** The icon of the WSL distribution a shell launch starts, when that
 * distribution ships one; saved profiles and open tabs match by name. */
export function useWslDistributionIcon(launch: {
  shell?: string;
  args?: readonly string[];
}): string | undefined {
  const platform = useAppInfo().data?.platform;
  const { data } = useWslDistributions(platform === 'win32');
  return data?.distributions.find(
    (distribution) => distribution.icon && opensWslDistribution(launch, distribution.name),
  )?.icon;
}

/** Copy an automatically listed distribution into the saved profiles, where
 * it can be customized; the automatic entry then stops being listed. */
export function saveWslShellProfile(profile: LocalShellProfileConfig): void {
  const { localShellProfiles, set } = usePrefsStore.getState();
  set({
    localShellProfiles: [
      ...localShellProfiles,
      { ...profile, id: newLocalShellProfileId(localShellProfiles.length) },
    ],
  });
}
