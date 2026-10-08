import { useEffect } from 'react';
import Paper from '@mui/material/Paper';
import { useQueryClient } from '@tanstack/react-query';
import { defaultLocalCopySyncDeps, localCopyChanged } from '../local-copy-sync.js';
import { useLocalCopiesStore } from '../state/local-copies.js';
import { TransferProgress } from './TransferProgress.js';

/**
 * Uploads saves of files opened with local programs, and shows that upload's
 * progress in a corner of the window: the file browser that opened the file
 * may be closed by then. Mounted once a file has been opened that way.
 */
export function LocalCopySync() {
  const queryClient = useQueryClient();
  const upload = useLocalCopiesStore((state) => state.upload);

  useEffect(() => {
    const deps = defaultLocalCopySyncDeps((connId) => {
      void queryClient.invalidateQueries({ queryKey: ['sftp-list', connId] });
    });
    if (!deps) return undefined;
    return window.muxusDesktop?.onLocalCopyChanged?.((change) => {
      void localCopyChanged(change, deps);
    });
  }, [queryClient]);

  if (!upload) return null;
  return (
    <Paper
      elevation={6}
      aria-live="polite"
      aria-label="Upload progress"
      sx={(theme) => ({
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: theme.zIndex.snackbar,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: 1.5,
        bgcolor: 'background.paper',
      })}
    >
      <TransferProgress transfer={upload} host={upload.host} onCancel={upload.cancel} sx={{ border: 0 }} />
    </Paper>
  );
}
