import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import CloseIcon from '@mui/icons-material/Close';
import { copyToClipboard } from '../clipboard.js';
import { useToastStore } from '../state/toast.js';

/** The single snackbar for all `showToast` notifications; mounted once in App. */
export function ToastHost() {
  const toast = useToastStore((s) => s.toast);
  const dismiss = useToastStore((s) => s.dismiss);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setCopied(false);
  }, [toast?.id]);

  const copyable = !!toast && (toast.severity === 'error' || toast.severity === 'warning');
  const copyText = toast ? [toast.message, toast.details].filter(Boolean).join('\n\n') : '';
  return (
    <Snackbar
      key={toast?.id}
      open={!!toast}
      // Reading expanded details must not race the auto-hide timer.
      autoHideDuration={expanded ? null : 5000}
      onClose={(_e, reason) => {
        if (reason === 'clickaway' && expanded) return;
        dismiss();
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity={toast?.severity ?? 'info'}
        variant="filled"
        sx={{ maxWidth: 560 }}
        action={
          <>
            {copyable && (
              <Button
                color="inherit"
                size="small"
                onClick={() =>
                  void copyToClipboard(copyText).then((ok) => {
                    if (ok) setCopied(true);
                  })
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
            {toast?.details && (
              <Button color="inherit" size="small" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Less' : 'Details'}
              </Button>
            )}
            <IconButton size="small" color="inherit" onClick={dismiss} aria-label="Close notification">
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        {toast?.message}
        {toast?.details && (
          <Collapse in={expanded}>
            <Box
              component="pre"
              sx={{ m: 0, mt: 1, maxHeight: 240, overflow: 'auto', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {toast.details}
            </Box>
          </Collapse>
        )}
      </Alert>
    </Snackbar>
  );
}
