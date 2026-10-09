import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import type { PasswordVaultSecret, VaultSecretSaveResult } from '@muxus/shared';
import {
  createVaultSecret,
  revealSavedPassword,
  updateVaultSecret,
} from '../api/password-vault.js';

const NAME_MAX = 80;
const USERNAME_MAX = 256;
const VALUE_MAX_BYTES = 8192;

/**
 * Add a named secret, or view and edit one. Both take the master password,
 * like every other way to see or change a saved value; editing asks for it
 * first and then shows the current value.
 */
export function VaultSecretDialog({
  secret,
  initialName = '',
  onClose,
  onSaved,
}: {
  /** The secret to edit; absent adds a new one. */
  secret?: PasswordVaultSecret;
  initialName?: string;
  onClose: () => void;
  onSaved: (result: VaultSecretSaveResult) => void;
}) {
  const editing = !!secret;
  const [masterPassword, setMasterPassword] = useState('');
  const [revealed, setRevealed] = useState(!editing);
  const [name, setName] = useState(secret?.name ?? initialName);
  const [username, setUsername] = useState(secret?.username ?? '');
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState<string>();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Start typing in the first field: the name, or the master password before an edit.
  useEffect(() => {
    const frame = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [revealed]);

  const close = () => {
    setMasterPassword('');
    setValue('');
    setSavedValue(undefined);
    onClose();
  };

  const reveal = async () => {
    if (!secret) return;
    if (!masterPassword) {
      setError('Enter the master password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await revealSavedPassword(secret.id, masterPassword);
      setValue(result.password);
      setSavedValue(result.password);
      setRevealed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Give the secret a name.');
      return;
    }
    if (!value) {
      setError('Enter the secret to save.');
      return;
    }
    if (new TextEncoder().encode(value).byteLength > VALUE_MAX_BYTES) {
      setError('The secret is too long to save.');
      return;
    }
    if (!masterPassword) {
      setError('Enter the master password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const input = {
        name: name.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(value !== savedValue ? { value } : {}),
        masterPassword,
      };
      const result = secret
        ? await updateVaultSecret(secret.id, input)
        : await createVaultSecret(input);
      setMasterPassword('');
      setValue('');
      setSavedValue(undefined);
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => void (revealed ? save() : reveal());
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : close} maxWidth="xs" fullWidth>
      <DialogTitle>{editing ? 'View or edit secret' : 'Add secret'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="textSecondary">
            {editing && !revealed
              ? `Enter the master password to see or change “${secret.name}”.`
              : 'A password or PIN to type into sessions, such as an enable or sudo password. Command buttons and Send secret… type it without showing it.'}
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {revealed ? (
            <>
              <TextField
                label="Name"
                value={name}
                inputRef={firstFieldRef}
                onChange={(event) => setName(event.target.value)}
                slotProps={{ htmlInput: { maxLength: NAME_MAX } }}
              />
              <TextField
                label="User name (optional)"
                value={username}
                autoComplete="off"
                onChange={(event) => setUsername(event.target.value)}
                slotProps={{ htmlInput: { maxLength: USERNAME_MAX, spellCheck: false } }}
              />
              <TextField
                label="Secret"
                type={visible ? 'text' : 'password'}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label={visible ? 'Hide secret' : 'Show secret'}
                          edge="end"
                          onClick={() => setVisible((current) => !current)}
                        >
                          {visible ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </>
          ) : null}
          {revealed && editing ? null : (
            <TextField
              label="Master password"
              type="password"
              autoComplete="off"
              inputRef={editing ? firstFieldRef : undefined}
              value={masterPassword}
              onChange={(event) => setMasterPassword(event.target.value)}
              onKeyDown={submitOnEnter}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button variant="contained" disabled={busy} onClick={submit}>
          {busy ? 'Working…' : revealed ? 'Save secret' : 'Continue'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
