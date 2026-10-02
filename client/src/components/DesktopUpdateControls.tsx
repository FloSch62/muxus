import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import type { DesktopUpdateState } from '@muxus/shared';
import { confirmAction } from '../state/dialogs.js';
import { showToast } from '../state/toast.js';
import { SettingRow, StatusText } from './SettingsLayout.js';

/**
 * The desktop app's update state, pushed by the main process. `ready` turns
 * true once the first answer arrives; `state` stays undefined in a browser.
 */
export function useDesktopUpdate(): { ready: boolean; state?: DesktopUpdateState } {
  const [update, setUpdate] = useState<{ ready: boolean; state?: DesktopUpdateState }>(() => ({
    ready: !window.muxusDesktop,
  }));
  useEffect(() => {
    const desktop = window.muxusDesktop;
    if (!desktop) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = desktop.onUpdateState((state) => {
      receivedEvent = true;
      setUpdate({ ready: true, state });
    });
    void desktop
      .getUpdateState()
      .catch(() => undefined)
      .then((state) => {
        if (active && !receivedEvent) setUpdate({ ready: true, state });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return update;
}

export function checkForDesktopUpdates(): void {
  void window.muxusDesktop?.checkForUpdates().catch(() =>
    showToast('error', 'The update check could not be completed. Try again.'),
  );
}

export function downloadDesktopUpdate(): void {
  void window.muxusDesktop?.downloadUpdate().catch(() =>
    showToast('error', 'The download could not be started. Try again from Settings → About.'),
  );
}

export async function restartToUpdate(): Promise<void> {
  const confirmed = await confirmAction({
    title: 'Restart Muxus to update?',
    description:
      'All Muxus windows will close and every session disconnects: terminals, file transfers, tunnels and remote desktops. Save open remote files first.',
    confirmLabel: 'Restart to update',
  });
  if (!confirmed) return;
  const accepted = await window.muxusDesktop?.installUpdate().catch(() => false);
  if (!accepted) showToast('error', 'The update could not be started. Try again from Settings → About.');
}

export async function installStoreUpdate(): Promise<void> {
  const confirmed = await confirmAction({
    title: 'Update Muxus through Microsoft Store?',
    description:
      'Windows may close all Muxus windows to install the update, and every session disconnects. Save open remote files first. Windows asks you to confirm the download.',
    confirmLabel: 'Update now',
  });
  if (!confirmed) return;
  const accepted = await window.muxusDesktop?.installUpdate().catch(() => false);
  if (!accepted) showToast('warning', 'The update could not be started. Check for updates again in Settings → About.');
}

export function openMicrosoftStore(): void {
  void window.muxusDesktop?.openStore().catch(() =>
    showToast('warning', 'Microsoft Store could not be opened. Open it from the Start menu to check for Muxus updates.'),
  );
}

function storeStatus(state: DesktopUpdateState): React.ReactNode {
  switch (state.status) {
    case 'checking':
      return 'Asking Microsoft Store for updates…';
    case 'available':
      return <StatusText tone="info">A new version of Muxus is available in Microsoft Store.</StatusText>;
    case 'installing':
      return state.percent === undefined
        ? 'Waiting for Microsoft Store…'
        : `Updating Muxus through Microsoft Store… ${state.percent}%`;
    case 'updated':
      return <StatusText tone="success">Microsoft Store completed the update. Reopen Muxus to use the installed version.</StatusText>;
    case 'up-to-date':
      return <StatusText tone="success">Microsoft Store reports no available updates.</StatusText>;
    case 'error':
      return <StatusText tone="warning">{state.error}</StatusText>;
    default:
      return 'Microsoft Store manages updates for this installation.';
  }
}

function releaseStatus(state: DesktopUpdateState): React.ReactNode {
  switch (state.status) {
    case 'checking':
      return 'Checking GitHub for the latest release…';
    case 'available':
      return (
        <StatusText tone="info">
          Muxus {state.version} is available. You are running {state.currentVersion}.
        </StatusText>
      );
    case 'downloading':
      return `Downloading Muxus ${state.version}… ${state.percent ?? 0}%`;
    case 'ready':
      return <StatusText tone="info">Muxus {state.version} is downloaded. Restart Muxus to install it.</StatusText>;
    case 'installing':
      return 'Restarting Muxus to install the update…';
    case 'up-to-date':
      return <StatusText tone="success">Muxus is up to date.</StatusText>;
    case 'error':
      return <StatusText tone="warning">{state.error}</StatusText>;
    default:
      return 'Downloads and installation start only when you choose them. Quitting normally never installs an update.';
  }
}

/** The About page's update row for installations that update themselves. */
export function DesktopUpdateRow({ state }: { state: DesktopUpdateState }) {
  const store = state.source === 'store';
  const checking = state.status === 'checking';
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  const canDownload = !store && (state.status === 'available' || (state.status === 'error' && !!state.version));
  const showProgress = state.status === 'downloading' || (store && state.status === 'installing');
  return (
    <SettingRow
      label="Update check"
      description={
        <>
          {store ? storeStatus(state) : releaseStatus(state)}
          {showProgress ? (
            <Box component="span" sx={{ display: 'block', mt: 1 }}>
              <LinearProgress
                aria-label={store ? 'Store update progress' : 'Update download'}
                variant={state.percent === undefined ? 'indeterminate' : 'determinate'}
                value={state.percent ?? 0}
              />
            </Box>
          ) : null}
        </>
      }
      control={
        <>
          {canDownload ? (
            <Button variant="contained" size="small" startIcon={<DownloadOutlinedIcon />} onClick={downloadDesktopUpdate}>
              Download update
            </Button>
          ) : null}
          {!store && state.status === 'ready' ? (
            <Button variant="contained" size="small" startIcon={<RestartAltOutlinedIcon />} onClick={() => void restartToUpdate()}>
              Restart to update
            </Button>
          ) : null}
          {store && state.status === 'available' ? (
            <Button variant="contained" size="small" startIcon={<DownloadOutlinedIcon />} onClick={() => void installStoreUpdate()}>
              Update now
            </Button>
          ) : null}
          {store ? (
            <Button variant="outlined" size="small" startIcon={<StorefrontOutlinedIcon />} disabled={busy} onClick={openMicrosoftStore}>
              Open Microsoft Store
            </Button>
          ) : null}
          <Button
            variant={canDownload || state.status === 'ready' || (store && state.status === 'available') ? 'outlined' : 'contained'}
            size="small"
            startIcon={checking ? <CircularProgress color="inherit" size={14} /> : <CachedOutlinedIcon />}
            disabled={busy || state.status === 'ready' || state.status === 'updated'}
            onClick={checkForDesktopUpdates}
          >
            Check for updates
          </Button>
        </>
      }
    />
  );
}
