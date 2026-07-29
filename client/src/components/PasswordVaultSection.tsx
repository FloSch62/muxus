import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type {
  PasswordVaultCredential,
  PasswordVaultStatus,
} from '@muxus/shared';
import {
  changeMasterPassword,
  createPasswordVault,
  deletePasswordVault,
  forgetSavedPassword,
  repairPasswordVaultAutomaticAccess,
  revealSavedPassword,
  updateSavedPassword,
} from '../api/password-vault.js';
import { usePasswordVaultStatus } from '../api/queries.js';
import { confirmAction } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';

type MasterDialogMode = 'create' | 'change' | 'repair';

export function PasswordVaultSection() {
  const queryClient = useQueryClient();
  const result = usePasswordVaultStatus();
  const status = result.data;
  const [dialogMode, setDialogMode] = useState<MasterDialogMode>();
  const [editing, setEditing] = useState<PasswordVaultCredential>();
  const [busy, setBusy] = useState(false);

  const acceptStatus = (next: PasswordVaultStatus) => {
    queryClient.setQueryData(['password-vault'], next);
  };

  const forget = async (id: string, label: string) => {
    const confirmed = await confirmAction({
      title: 'Forget saved password?',
      description: `Muxus will ask for the password to ${label} next time.`,
      confirmLabel: 'Forget password',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await forgetSavedPassword(id);
      await queryClient.invalidateQueries({ queryKey: ['password-vault'] });
      showToast('success', `Forgot the password for ${label}.`);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const removeVault = async () => {
    const confirmed = await confirmAction({
      title: 'Delete the password vault?',
      description:
        'Every saved SSH password will be permanently removed. Connection profiles and SSH keys are not affected.',
      confirmLabel: 'Delete vault',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      acceptStatus(await deletePasswordVault());
      showToast('success', 'Password vault deleted.');
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusy(false);
    }
  };

  if (result.isError) {
    return (
      <Alert severity="error">
        {result.error instanceof Error
          ? result.error.message
          : 'Could not read password-vault status.'}
      </Alert>
    );
  }

  if (result.isLoading || !status) {
    return (
      <Stack
        sx={{ minHeight: 180, alignItems: 'center', justifyContent: 'center' }}
      >
        <CircularProgress size={24} />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
          Password vault
        </Typography>
        {!status.configured ? (
          <Alert severity="info" sx={{ mb: 2 }}>
            Password saving is off. Create a master password to protect viewing
            and editing saved SSH passwords.
          </Alert>
        ) : status.automaticAccess ? (
          <Alert severity="success" sx={{ mb: 2 }}>
            Automatic access is ready. SSH connections can use saved passwords
            without asking for the master password.
          </Alert>
        ) : (
          <Alert severity="error" sx={{ mb: 2 }}>
            Automatic access needs repair. This can happen when the database is
            restored without its companion device-key file.
          </Alert>
        )}

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {!status.configured ? (
            <Button
              variant="contained"
              startIcon={<PasswordOutlinedIcon />}
              onClick={() => setDialogMode('create')}
            >
              Create password vault
            </Button>
          ) : (
            <>
              {!status.automaticAccess ? (
                <Button
                  variant="contained"
                  onClick={() => setDialogMode('repair')}
                >
                  Repair automatic access
                </Button>
              ) : null}
              <Button
                variant="outlined"
                onClick={() => setDialogMode('change')}
              >
                Change master password
              </Button>
              <Button
                color="error"
                disabled={busy}
                onClick={() => void removeVault()}
              >
                Delete vault
              </Button>
            </>
          )}
        </Stack>
      </Box>

      {status.configured ? (
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
            Saved SSH passwords
          </Typography>
          {status.credentials.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              None yet. Select “Remember this password” the next time SSH asks
              for one.
            </Typography>
          ) : (
            <List disablePadding>
              {status.credentials.map((credential) => (
                <ListItem
                  key={credential.id}
                  divider
                  disableGutters
                  secondaryAction={
                    <Stack direction="row">
                      <Tooltip title="View or edit password">
                        <IconButton
                          edge="end"
                          aria-label={`View or edit password for ${credential.label}`}
                          onClick={() => setEditing(credential)}
                        >
                          <EditOutlinedIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Forget password">
                        <IconButton
                          edge="end"
                          aria-label={`Forget password for ${credential.label}`}
                          onClick={() =>
                            void forget(credential.id, credential.label)
                          }
                        >
                          <DeleteOutlineIcon />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  }
                >
                  <ListItemText
                    primary={credential.label}
                    secondary={`Updated ${new Date(credential.updatedAt).toLocaleString()}`}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      ) : null}

      <Typography variant="caption" color="text.secondary">
        Your master password is required to view or edit saved values. Routine
        SSH connections use a separate local device key automatically. The
        device key is stored beside the database, so protect your operating
        system account and application-data directory. Two-factor codes and
        private-key passphrases are never remembered.
      </Typography>

      {dialogMode ? (
        <MasterPasswordDialog
          key={dialogMode}
          mode={dialogMode}
          onClose={() => setDialogMode(undefined)}
          onSaved={(next) => {
            acceptStatus(next);
            setDialogMode(undefined);
            showToast(
              'success',
              dialogMode === 'create'
                ? 'Password vault created.'
                : dialogMode === 'repair'
                  ? 'Automatic password access repaired.'
                  : 'Master password changed.',
            );
          }}
        />
      ) : null}

      {editing ? (
        <EditSavedPasswordDialog
          credential={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(next) => {
            acceptStatus(next);
            setEditing(undefined);
            showToast('success', `Updated the password for ${editing.label}.`);
          }}
        />
      ) : null}
    </Stack>
  );
}

function MasterPasswordDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: MasterDialogMode;
  onClose: () => void;
  onSaved: (status: PasswordVaultStatus) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const creating = mode === 'create';
  const changing = mode === 'change';
  const proposed = creating ? currentPassword : nextPassword;

  const submit = async () => {
    if ((creating || changing) && Array.from(proposed).length < 8) {
      setError('Use at least 8 characters for the master password.');
      return;
    }
    if (
      (creating || changing) &&
      new TextEncoder().encode(proposed).byteLength > 1024
    ) {
      setError('The master password is too long.');
      return;
    }
    if ((creating || changing) && proposed !== confirmation) {
      setError('The master-password confirmation does not match.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const status =
        mode === 'create'
          ? await createPasswordVault(currentPassword)
          : mode === 'repair'
            ? await repairPasswordVaultAutomaticAccess(currentPassword)
            : await changeMasterPassword(currentPassword, nextPassword);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmation('');
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const title =
    mode === 'create'
      ? 'Create password vault'
      : mode === 'repair'
        ? 'Repair automatic access'
        : 'Change master password';

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          {creating ? (
            <Typography variant="body2" color="text.secondary">
              Use at least 8 characters. This password will be required to view
              or edit saved values, but not for routine SSH connections.
            </Typography>
          ) : null}
          {mode === 'repair' ? (
            <Typography variant="body2" color="text.secondary">
              Enter the master password to link this database to a new local
              device key.
            </Typography>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            label={
              changing ? 'Current master password' : 'Master password'
            }
            type="password"
            autoComplete="off"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && mode === 'repair') void submit();
            }}
          />
          {changing ? (
            <TextField
              label="New master password"
              type="password"
              autoComplete="off"
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
            />
          ) : null}
          {creating || changing ? (
            <TextField
              label="Confirm master password"
              type="password"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={saving}
          onClick={() => void submit()}
        >
          {saving
            ? 'Working…'
            : mode === 'create'
              ? 'Create vault'
              : mode === 'repair'
                ? 'Repair'
                : 'Change password'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EditSavedPasswordDialog({
  credential,
  onClose,
  onSaved,
}: {
  credential: PasswordVaultCredential;
  onClose: () => void;
  onSaved: (status: PasswordVaultStatus) => void;
}) {
  const [masterPassword, setMasterPassword] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const close = () => {
    setMasterPassword('');
    setPassword('');
    setVisible(false);
    onClose();
  };

  const reveal = async () => {
    if (Array.from(masterPassword).length < 8) {
      setError('Enter the master password.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const result = await revealSavedPassword(
        credential.id,
        masterPassword,
      );
      setPassword(result.password);
      setRevealed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (new TextEncoder().encode(password).byteLength > 8192) {
      setError('The SSH password is too long to save.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const status = await updateSavedPassword(
        credential.id,
        masterPassword,
        password,
      );
      setMasterPassword('');
      setPassword('');
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : close} maxWidth="xs" fullWidth>
      <DialogTitle>View or edit saved password</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {credential.label}
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {!revealed ? (
            <TextField
              label="Master password"
              type="password"
              autoComplete="off"
              value={masterPassword}
              onChange={(event) => setMasterPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void reveal();
              }}
            />
          ) : (
            <TextField
              label="SSH password"
              type={visible ? 'text' : 'password'}
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label={
                          visible ? 'Hide saved password' : 'Show saved password'
                        }
                        edge="end"
                        onClick={() => setVisible((current) => !current)}
                      >
                        {visible ? (
                          <VisibilityOffOutlinedIcon />
                        ) : (
                          <VisibilityOutlinedIcon />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save();
              }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={saving}
          onClick={() => void (revealed ? save() : reveal())}
        >
          {saving ? 'Working…' : revealed ? 'Save password' : 'Continue'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
