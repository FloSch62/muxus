import { useMemo } from 'react';
import { useAppInfo, useWslDistributions } from './api/queries.js';
import { wslShellProfiles } from './local-shell-profile.js';
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
