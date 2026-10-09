import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import { useLocalCopiesStore } from '../state/local-copies.js';
import { useSftpUploadsStore } from '../state/sftp-uploads.js';
import { TransferProgress } from './TransferProgress.js';

/**
 * Progress of files dropped onto SSH terminals whose file browser is not on
 * screen, in the corner where uploads of locally opened files show. A file
 * browser showing the connection reports the upload itself.
 */
export function TerminalUploadProgress() {
  const uploads = useSftpUploadsStore((state) => state.uploads);
  const browsers = useSftpUploadsStore((state) => state.browsers);
  // Sits above the card of a local copy being uploaded back.
  const besideLocalCopy = useLocalCopiesStore((state) => !!state.upload);
  const unseen = Object.values(uploads).filter((upload) => !browsers[upload.connId]);
  if (unseen.length === 0) return null;
  return (
    <Stack
      spacing={1}
      aria-live="polite"
      sx={(theme) => ({
        position: 'fixed',
        left: 16,
        bottom: besideLocalCopy ? 104 : 16,
        zIndex: theme.zIndex.snackbar,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
      })}
    >
      {unseen.map((upload) => (
        <Paper
          key={upload.connId}
          elevation={6}
          aria-label="Upload progress"
          sx={{ borderRadius: 1.5, bgcolor: 'background.paper' }}
        >
          <TransferProgress
            transfer={upload}
            host={upload.host}
            onCancel={upload.cancel}
            sx={{ border: 0 }}
          />
        </Paper>
      ))}
    </Stack>
  );
}
