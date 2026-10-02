import type { DesktopUpdateState } from '@muxus/shared';

/** The in-app updater owns updates; otherwise the release-manifest check does. */
export function isInAppUpdater(state: DesktopUpdateState | undefined): state is DesktopUpdateState {
  return !!state && state.status !== 'disabled';
}

export interface DesktopUpdateNotice {
  /** Identifies one decision, so dismissing it never hides a later step. */
  key: string;
  message: string;
  tone: 'info' | 'warning';
  /**
   * Store updates do not reveal the target version, so their dismissal lasts
   * only for this run and cannot hide a different future update.
   */
  persistDismissal: boolean;
}

export function desktopUpdateNotice(state: DesktopUpdateState | undefined): DesktopUpdateNotice | undefined {
  if (!isInAppUpdater(state)) return undefined;
  if (state.source === 'store') {
    if (!['available', 'updated', 'error'].includes(state.status)) return undefined;
    return {
      key: `store:${state.currentVersion}:${state.status}`,
      message: state.status === 'error'
        ? state.error ?? 'Microsoft Store could not check for updates.'
        : state.status === 'updated'
          ? 'Microsoft Store completed the update. Reopen Muxus to use the installed version.'
          : 'A new version of Muxus is available in Microsoft Store.',
      tone: state.status === 'error' ? 'warning' : 'info',
      persistDismissal: false,
    };
  }
  // Availability and a completed download are separate decisions, and a
  // background check failing before any update was found is not worth a notice.
  if (!state.version || !['available', 'ready', 'error'].includes(state.status)) return undefined;
  return {
    key: `${state.version}:${state.status}`,
    message: state.status === 'error'
      ? state.error ?? 'The update could not be completed.'
      : state.status === 'ready'
        ? `Muxus ${state.version} is downloaded and ready to install.`
        : `Muxus ${state.version} is available. You are running ${state.currentVersion}.`,
    tone: state.status === 'error' ? 'warning' : 'info',
    persistDismissal: true,
  };
}
