import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import type { UpdateCheckResult } from '@muxus/shared';
import { checkForUpdate as checkForAppUpdate } from '../api/app.js';
import { muxusStateStorage } from '../state/persist-storage.js';

const DISMISSED_UPDATE_KEY = 'muxus-dismissed-update-version';

let updateCheck: Promise<UpdateCheckResult> | undefined;

async function readDismissedVersion(): Promise<string | null> {
  try {
    return await muxusStateStorage.getItem(DISMISSED_UPDATE_KEY);
  } catch {
    return null;
  }
}

async function dismissVersion(version: string): Promise<void> {
  try {
    await muxusStateStorage.setItem(DISMISSED_UPDATE_KEY, version);
  } catch {
    /* Dismissal is a nicety; ignore blocked storage. */
  }
}

function checkForUpdate(): Promise<UpdateCheckResult> {
  updateCheck ??= checkForAppUpdate();
  return updateCheck;
}

export function UpdateNotification() {
  const [update, setUpdate] = useState<Extract<UpdateCheckResult, { available: true }> | null>(null);

  useEffect(() => {
    const check = checkForUpdate();

    let cancelled = false;
    void check
      .then(async (result) => {
        if (!result.available) return;
        const dismissedVersion = await readDismissedVersion();
        if (cancelled || dismissedVersion === result.latestVersion) return;
        setUpdate(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    if (update) void dismissVersion(update.latestVersion);
    setUpdate(null);
  };

  return (
    <Snackbar open={!!update} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert
        severity="info"
        variant="filled"
        onClose={dismiss}
        action={
          update ? (
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" href={update.releaseUrl} target="_blank" rel="noreferrer" onClick={dismiss}>
                Download
              </Button>
              <Button color="inherit" size="small" onClick={dismiss}>
                Later
              </Button>
            </Stack>
          ) : undefined
        }
      >
        Muxus {update?.latestVersion} is available. You are running {update?.currentVersion}.
      </Alert>
    </Snackbar>
  );
}
