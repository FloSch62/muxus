import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import type { DesktopUpdateState, UpdateCheckResult } from '@muxus/shared';
import { checkForUpdate as checkForAppUpdate } from '../api/app.js';
import { muxusStateStorage } from '../state/persist-storage.js';
import { usePrefsStore } from '../state/prefs.js';
import { desktopUpdateNotice, isInAppUpdater } from '../update-notice.js';
import {
  downloadDesktopUpdate,
  installStoreUpdate,
  openMicrosoftStore,
  restartToUpdate,
  useDesktopUpdate,
} from './DesktopUpdateControls.js';

const DISMISSED_UPDATE_KEY = 'muxus-dismissed-update-version';
const DISMISSED_DESKTOP_UPDATE_KEY = 'muxus-dismissed-desktop-update';

let updateCheck: Promise<UpdateCheckResult> | undefined;

async function readDismissed(key: string): Promise<string | null> {
  try {
    return await muxusStateStorage.getItem(key);
  } catch {
    return null;
  }
}

async function dismiss(key: string, value: string): Promise<void> {
  try {
    await muxusStateStorage.setItem(key, value);
  } catch {
    /* Dismissal is a nicety; ignore blocked storage. */
  }
}

function checkForUpdate(): Promise<UpdateCheckResult> {
  updateCheck ??= checkForAppUpdate();
  return updateCheck;
}

export function UpdateNotification() {
  const notifyOnNewVersion = usePrefsStore((s) => s.notifyOnNewVersion);
  const update = useDesktopUpdate();

  // The main process checks in the background only while notifications are on.
  useEffect(() => {
    window.muxusDesktop?.setAutomaticUpdateChecks(notifyOnNewVersion);
  }, [notifyOnNewVersion]);

  if (!notifyOnNewVersion || !update.ready) return null;
  return isInAppUpdater(update.state) ? (
    <DesktopUpdateNotification state={update.state} />
  ) : (
    <ReleaseUpdateNotification />
  );
}

function MuteUpdatesLink({ onMuted }: { onMuted?: () => void }) {
  const setPrefs = usePrefsStore((s) => s.set);
  return (
    <Link
      component="button"
      type="button"
      color="inherit"
      variant="caption"
      onClick={() => {
        setPrefs({ notifyOnNewVersion: false });
        onMuted?.();
      }}
      sx={{ display: 'block', mt: 0.5, opacity: 0.85, textDecorationColor: 'currentcolor' }}
    >
      Don’t notify me again
    </Link>
  );
}

function UpdateSnackbar({
  open,
  tone = 'info',
  message,
  actions,
  onMuted,
}: {
  open: boolean;
  tone?: 'info' | 'warning';
  message: React.ReactNode;
  actions: React.ReactNode;
  onMuted?: () => void;
}) {
  return (
    <Snackbar open={open} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert severity={tone} variant="filled">
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <span>{message}</span>
          {/* The negative margin keeps the row at text height, so the buttons
              center on the message line instead of pushing it apart. */}
          <Stack direction="row" spacing={0.5} sx={{ my: '-5px' }}>
            {actions}
          </Stack>
        </Stack>
        <MuteUpdatesLink onMuted={onMuted} />
      </Alert>
    </Snackbar>
  );
}

/** Installed desktop releases: download and install inside Muxus. */
function DesktopUpdateNotification({ state }: { state: DesktopUpdateState }) {
  const notice = desktopUpdateNotice(state);
  // Store dismissals live only in memory; see desktopUpdateNotice.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void readDismissed(DISMISSED_DESKTOP_UPDATE_KEY).then((value) => {
      if (active) setDismissed((current) => (current === undefined ? value : current));
    });
    return () => {
      active = false;
    };
  }, []);

  if (!notice || dismissed === undefined) return null;
  const later = () => {
    setDismissed(notice.key);
    if (notice.persistDismissal) void dismiss(DISMISSED_DESKTOP_UPDATE_KEY, notice.key);
  };
  const act = (action: () => unknown) => () => {
    later();
    void action();
  };
  const store = state.source === 'store';

  return (
    <UpdateSnackbar
      open={notice.key !== dismissed}
      tone={notice.tone}
      message={notice.message}
      actions={
        <>
          {store && state.status === 'available' ? (
            <Button color="inherit" size="small" onClick={act(installStoreUpdate)}>
              Update now
            </Button>
          ) : null}
          {store && state.status === 'error' ? (
            <Button color="inherit" size="small" onClick={act(openMicrosoftStore)}>
              Open Microsoft Store
            </Button>
          ) : null}
          {!store && state.status === 'ready' ? (
            <Button color="inherit" size="small" onClick={() => void restartToUpdate()}>
              Restart to update
            </Button>
          ) : null}
          {!store && state.status !== 'ready' ? (
            <Button color="inherit" size="small" onClick={act(downloadDesktopUpdate)}>
              Download update
            </Button>
          ) : null}
          <Button color="inherit" size="small" onClick={later}>
            Later
          </Button>
        </>
      }
      onMuted={later}
    />
  );
}

/** Browser, development and Linux package installs: point to the GitHub release. */
function ReleaseUpdateNotification() {
  const [update, setUpdate] = useState<Extract<UpdateCheckResult, { available: true }> | null>(null);

  useEffect(() => {
    const check = checkForUpdate();

    let cancelled = false;
    void check
      .then(async (result) => {
        if (!result.available) return;
        const dismissedVersion = await readDismissed(DISMISSED_UPDATE_KEY);
        if (cancelled || dismissedVersion === result.latestVersion) return;
        setUpdate(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const later = () => {
    if (update) void dismiss(DISMISSED_UPDATE_KEY, update.latestVersion);
    setUpdate(null);
  };

  return (
    <UpdateSnackbar
      open={!!update}
      message={`Muxus ${update?.latestVersion} is available. You are running ${update?.currentVersion}.`}
      actions={
        <>
          <Button color="inherit" size="small" href={update?.releaseUrl ?? ''} target="_blank" rel="noreferrer" onClick={later}>
            Download
          </Button>
          <Button color="inherit" size="small" onClick={later}>
            Later
          </Button>
        </>
      }
      onMuted={() => setUpdate(null)}
    />
  );
}
