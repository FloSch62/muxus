import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
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
import {
  DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
  type PasswordVaultCredential,
  type PasswordVaultStatus,
  type PasswordVaultUnlockPolicy,
} from '@muxus/shared';
import {
  changeMasterPassword,
  changePasswordVaultUnlockPolicy,
  createPasswordVault,
  deletePasswordVault,
  forgetSavedPassword,
  repairPasswordVaultAutomaticAccess,
  revealSavedPassword,
  unlockPasswordVault,
  updateSavedPassword,
} from '../api/password-vault.js';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import { confirmAction } from '../state/dialogs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import {
  SettingRow,
  SettingsGroup,
  SettingsPage,
  StatusText,
  type StatusTone,
} from './SettingsLayout.js';

type MasterDialogMode =
  | 'create'
  | 'change'
  | 'repair'
  | 'unlock'
  | 'policy';

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
        'Every saved SSH password will be securely removed from the active database. Muxus also removes the OS credential-store copy when that store is available. No master password is required, so deletion remains possible if it is forgotten. Existing backups or filesystem snapshots are not affected. Connection profiles and SSH keys are not affected.',
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
      <SettingsPage title="Passwords" description={DESCRIPTION}>
        <Alert severity="error" variant="outlined">
          {result.error instanceof Error
            ? result.error.message
            : 'Could not read password-vault status.'}
        </Alert>
      </SettingsPage>
    );
  }

  if (result.isLoading || !status) {
    return (
      <SettingsPage title="Passwords" description={DESCRIPTION}>
        <Skeleton variant="rounded" height={72} />
        <Skeleton variant="rounded" height={120} />
      </SettingsPage>
    );
  }

  const vaultState = vaultStatus(status);

  return (
    <SettingsPage title="Passwords" description={DESCRIPTION}>
      <SettingsGroup title="Vault">
        <SettingRow
          label="Password vault"
          description={<StatusText tone={vaultState.tone}>{vaultState.text}</StatusText>}
          control={
            !status.configured ? (
              <Button
                variant="contained"
                startIcon={<PasswordOutlinedIcon />}
                onClick={() => setDialogMode('create')}
              >
                Create password vault
              </Button>
            ) : status.locked && status.unlockPolicy === 'never' ? (
              <Button variant="contained" onClick={() => setDialogMode('repair')}>
                Restore OS access
              </Button>
            ) : status.locked && status.unlockPolicy === 'startup' ? (
              <Button variant="contained" onClick={() => setDialogMode('unlock')}>
                Unlock now
              </Button>
            ) : undefined
          }
        />
        {status.configured ? (
          <>
            <SettingRow
              label="Ask for the master password"
              description={
                UNLOCK_POLICY_LABELS[status.unlockPolicy ?? DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY]
              }
              control={
                <Button variant="outlined" onClick={() => setDialogMode('policy')}>
                  Change prompt policy
                </Button>
              }
            />
            <SettingRow
              label="Master password"
              description="Always required to view or edit saved values. It cannot be recovered."
              control={
                <Button variant="outlined" onClick={() => setDialogMode('change')}>
                  Change master password
                </Button>
              }
            />
            <SettingRow
              label="Delete the vault"
              description="Forgets every saved password; hosts, keys and other settings stay. Needs no master password, so a forgotten one can still be removed."
              control={
                <Button
                  variant="outlined"
                  color="error"
                  disabled={busy}
                  onClick={() => void removeVault()}
                >
                  Delete vault
                </Button>
              }
            />
          </>
        ) : null}
      </SettingsGroup>

      {status.configured ? (
        <SettingsGroup
          title={
            status.credentials.length
              ? `Saved SSH passwords · ${status.credentials.length}`
              : 'Saved SSH passwords'
          }
          flush
        >
          {status.credentials.length === 0 ? (
            <Typography
              variant="body2"
              color="textSecondary"
              sx={{ px: 2, py: 2.5, textAlign: 'center' }}
            >
              None yet. Select “Remember this password” the next time SSH asks for one.
            </Typography>
          ) : (
            status.credentials.map((credential) => (
              <Box
                key={credential.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 2,
                  py: 1.1,
                  '& + &': { borderTop: 1, borderColor: 'divider' },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 550 }} title={credential.label}>
                    {credential.label}
                  </Typography>
                  <Typography variant="caption" color="textSecondary" component="div">
                    Updated {new Date(credential.updatedAt).toLocaleString()}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
                  <Tooltip title="View or edit password">
                    <IconButton
                      size="small"
                      aria-label={`View or edit password for ${credential.label}`}
                      onClick={() => setEditing(credential)}
                    >
                      <EditOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Forget password">
                    <IconButton
                      size="small"
                      aria-label={`Forget password for ${credential.label}`}
                      onClick={() => void forget(credential.id, credential.label)}
                    >
                      <DeleteOutlineIcon color="error" sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Box>
            ))
          )}
        </SettingsGroup>
      ) : null}

      <Typography variant="caption" color="textSecondary" sx={{ mt: -1.5 }}>
        “Never” stores the vault key in the operating-system credential store;
        the other policies keep no usable vault key on disk. Two-factor codes
        and private-key passphrases are never remembered.
      </Typography>

      {dialogMode ? (
        <MasterPasswordDialog
          key={dialogMode}
          mode={dialogMode}
          initialUnlockPolicy={status.unlockPolicy}
          onClose={() => setDialogMode(undefined)}
          onSaved={(next) => {
            acceptStatus(next);
            setDialogMode(undefined);
            showToast(
              'success',
              dialogMode === 'create'
                ? 'Password vault created.'
                : dialogMode === 'repair'
                  ? 'OS credential-store access restored.'
                  : dialogMode === 'unlock'
                    ? 'Password vault unlocked.'
                    : dialogMode === 'policy'
                      ? 'Master-password prompt policy changed.'
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
    </SettingsPage>
  );
}

const DESCRIPTION =
  'An optional vault for SSH passwords, protected by a master password. Saved passwords stay on this machine and are never part of a backup.';

const UNLOCK_POLICY_LABELS: Record<PasswordVaultUnlockPolicy, string> = {
  never: 'Never for saved credentials: the vault key lives in the OS credential store.',
  startup: 'When Muxus starts: the vault is unlocked into memory once per app session.',
  credential: 'Whenever a saved credential is needed.',
};

/** What the vault can do right now, in the words and tone of its row. */
function vaultStatus(status: PasswordVaultStatus): { tone: StatusTone; text: string } {
  if (!status.configured) {
    return {
      tone: 'info',
      text: 'Password saving is off. Create a master password to protect viewing and editing saved SSH passwords.',
    };
  }
  if (status.unlockPolicy === 'credential') {
    return {
      tone: 'info',
      text: 'Muxus asks for the master password whenever a saved credential is needed.',
    };
  }
  if (!status.locked) {
    return {
      tone: 'success',
      text:
        status.unlockPolicy === 'never'
          ? 'OS credential-store access is ready. Saved passwords are used without a master-password prompt.'
          : 'Unlocked for this app session.',
    };
  }
  return status.unlockPolicy === 'never'
    ? {
        tone: 'error',
        text: 'The OS credential-store key is unavailable. Enter the master password to restore it.',
      }
    : { tone: 'warning', text: 'Needs the master password for this app session.' };
}

function MasterPasswordDialog({
  mode,
  initialUnlockPolicy,
  onClose,
  onSaved,
}: {
  mode: MasterDialogMode;
  initialUnlockPolicy?: PasswordVaultUnlockPolicy;
  onClose: () => void;
  onSaved: (status: PasswordVaultStatus) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [unlockPolicy, setUnlockPolicy] =
    useState<PasswordVaultUnlockPolicy>(
      initialUnlockPolicy ?? DEFAULT_PASSWORD_VAULT_UNLOCK_POLICY,
    );
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
          ? await createPasswordVault(currentPassword, unlockPolicy)
          : mode === 'repair'
            ? await repairPasswordVaultAutomaticAccess(currentPassword)
            : mode === 'unlock'
              ? await unlockPasswordVault(currentPassword)
              : mode === 'policy'
                ? await changePasswordVaultUnlockPolicy(
                    currentPassword,
                    unlockPolicy,
                  )
                : await changeMasterPassword(
                    currentPassword,
                    nextPassword,
                  );
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
        ? 'Restore OS credential-store access'
        : mode === 'unlock'
          ? 'Unlock password vault'
          : mode === 'policy'
            ? 'Master-password prompt policy'
            : 'Change master password';

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          {creating ? (
            <Typography variant="body2" color="textSecondary">
              Use at least 8 characters. This password is always required to
              view or edit saved values.
            </Typography>
          ) : null}
          {mode === 'repair' ? (
            <Typography variant="body2" color="textSecondary">
              Enter the master password to restore the vault key in the
              operating-system credential store.
            </Typography>
          ) : null}
          {mode === 'unlock' ? (
            <Typography variant="body2" color="textSecondary">
              The decrypted vault key remains in memory until Muxus exits.
            </Typography>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            label={
              changing || mode === 'policy'
                ? 'Current master password'
                : 'Master password'
            }
            type="password"
            autoComplete="off"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (mode === 'repair' || mode === 'unlock')
              ) {
                void submit();
              }
            }}
          />
          {creating || mode === 'policy' ? (
            <TextField
              select
              label="Ask for master password"
              value={unlockPolicy}
              onChange={(event) =>
                setUnlockPolicy(
                  event.target.value as PasswordVaultUnlockPolicy,
                )
              }
            >
              <MenuItem value="never">
                Never for saved credentials (OS keyring)
              </MenuItem>
              <MenuItem value="startup">When Muxus starts</MenuItem>
              <MenuItem value="credential">
                Whenever a saved credential is needed
              </MenuItem>
            </TextField>
          ) : null}
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
                ? 'Restore'
                : mode === 'unlock'
                  ? 'Unlock'
                  : mode === 'policy'
                    ? 'Save policy'
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
    // Legacy v2 vaults accepted eight-character passwords. Let the server
    // apply the format-specific minimum instead of duplicating it here.
    if (masterPassword.length === 0) {
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
          <Typography variant="body2" color="textSecondary">
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
