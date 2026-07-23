import { useEffect } from 'react';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/http.js';
import { useBackendStore } from '../state/backend.js';

const RETRY_MS = 3000;

/**
 * Global banner for the two cross-cutting backend failure states: the server
 * not answering at all, and the session token no longer being accepted.
 * While unreachable it pings until the server answers, then refetches
 * everything so the app snaps back without a manual reload.
 */
export function BackendStatusBanner() {
  const unreachable = useBackendStore((s) => s.unreachable);
  const authInvalid = useBackendStore((s) => s.authInvalid);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!unreachable) return;
    let cancelled = false;
    const timer = setInterval(() => {
      // A successful response flips the store back via statusFetch.
      apiFetch('/api/app/info')
        .then(() => {
          if (cancelled) return;
          void queryClient.invalidateQueries();
        })
        .catch(() => {});
    }, RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [unreachable, queryClient]);

  const open = unreachable || authInvalid;
  // Bottom-left keeps clear of ToastHost, which owns bottom-center.
  return (
    <Snackbar open={open} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
      <Alert
        severity={authInvalid ? 'error' : 'warning'}
        variant="filled"
        icon={authInvalid ? undefined : <CircularProgress color="inherit" size={18} />}
      >
        {authInvalid
          ? 'Session is no longer valid — restart Muxus to reconnect.'
          : 'Backend connection lost — retrying…'}
      </Alert>
    </Snackbar>
  );
}
