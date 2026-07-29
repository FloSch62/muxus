import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import { unlockPasswordVault } from '../api/password-vault.js';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import { shouldDelayWorkspaceRestoreForVault } from '../password-vault-startup.js';

/** Resolve the startup vault policy before persisted sessions are restored. */
export function PasswordVaultStartupUnlock({
  onReady,
}: {
  onReady: () => void;
}) {
  const queryClient = useQueryClient();
  const result = usePasswordVaultStatus();
  const [dismissed, setDismissed] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const status = result.data;
  const delayRestore = shouldDelayWorkspaceRestoreForVault({
    status,
    pending: result.isPending,
    failed: result.isError,
  });
  const ready = dismissed || !delayRestore;

  useEffect(() => {
    if (ready) onReady();
  }, [onReady, ready]);

  if (ready || !status) return null;

  const unlock = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await unlockPasswordVault(password);
      setPassword('');
      queryClient.setQueryData(['password-vault'], next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    setPassword('');
    setError(undefined);
    setDismissed(true);
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : dismiss}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Unlock password vault</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Enter the master password once to use saved SSH passwords until
            Muxus exits.
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            label="Master password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void unlock();
            }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={dismiss}>
          Not now
        </Button>
        <Button
          variant="contained"
          disabled={busy || password.length === 0}
          onClick={() => void unlock()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
