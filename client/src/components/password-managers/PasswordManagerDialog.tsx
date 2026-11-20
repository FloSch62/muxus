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
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import {
  PASSWORD_MANAGER_KINDS,
  PASSWORD_MANAGER_LABELS,
  type PasswordManagerConfig,
  type PasswordManagerKind,
  type PasswordManagerSource,
} from '@muxus/shared';
import { useSavePasswordManager } from '../../api/password-managers.js';
import { useFocusOnMount } from './useFocusOnMount.js';

/** What each kind needs before Muxus can read from it, and the program it runs. */
const KIND_NOTES: Record<PasswordManagerKind, { program?: string; note: string }> = {
  keepass: {
    note: 'Reads the .kdbx file directly, so KeePass, KeePassXC and compatible apps all work and none has to be running. You unlock it in Muxus with the database password; databases that need a hardware key are not supported.',
  },
  onepassword: {
    program: 'op',
    note: 'Uses the 1Password CLI (op). Turn on “Integrate with 1Password CLI” in the 1Password app under Settings → Developer; the app then asks you to approve access.',
  },
  bitwarden: {
    program: 'bw',
    note: 'Uses the Bitwarden CLI (bw), which also works with Vaultwarden. Log in once with “bw login” in a terminal; Muxus then unlocks the vault with your master password.',
  },
  protonpass: {
    program: 'pass-cli',
    note: 'Uses the Proton Pass CLI (pass-cli). Log in once with “pass-cli login” in a terminal.',
  },
  lastpass: {
    program: 'lpass',
    note: 'Uses the LastPass CLI (lpass). Log in once with “lpass login <email>” in a terminal.',
  },
  dashlane: {
    program: 'dcli',
    note: 'Uses the Dashlane CLI (dcli). Run “dcli sync” once in a terminal to log in and unlock it.',
  },
  pass: {
    program: 'gpg',
    note: 'Reads the standard Unix password store, as pass and gopass keep it, and decrypts entries with GnuPG. The passphrase prompt comes from gpg-agent.',
  },
};

/** Connect a password manager, or change how a connected one is reached. */
export function PasswordManagerDialog({
  source,
  installed,
  onClose,
  onSaved,
}: {
  /** The source being edited; absent to connect a new one. */
  source?: PasswordManagerSource;
  installed: readonly PasswordManagerKind[];
  onClose: () => void;
  onSaved?: (source: PasswordManagerSource) => void;
}) {
  const save = useSavePasswordManager();
  const [kind, setKind] = useState<PasswordManagerKind>(source?.kind ?? 'keepass');
  const [name, setName] = useState(source?.name ?? '');
  const [config, setConfig] = useState<PasswordManagerConfig>(source?.config ?? {});
  const set = (patch: PasswordManagerConfig) => setConfig((current) => ({ ...current, ...patch }));
  const notes = KIND_NOTES[kind];
  // A new KeePass connection starts in the one field it cannot do without.
  const focusRef = useFocusOnMount(!source && kind === 'keepass');
  const missingProgram = !!notes.program && !installed.includes(kind) && !config.program?.trim();
  const incomplete = kind === 'keepass' && !config.path?.trim();

  const submit = () => {
    if (incomplete) return;
    save.mutate(
      { id: source?.id, input: { kind, name: name.trim() || undefined, config } },
      {
        onSuccess: (saved) => {
          onSaved?.(saved);
          onClose();
        },
      },
    );
  };

  const browse = (target: 'database' | 'key-file' | 'store', field: 'path' | 'keyFile') => {
    void window.muxusDesktop?.selectPasswordManagerFile?.(target).then((file) => {
      if (file) set({ [field]: file });
    });
  };
  const browseButton = (target: 'database' | 'key-file' | 'store', field: 'path' | 'keyFile', label: string) =>
    window.muxusDesktop?.selectPasswordManagerFile
      ? {
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={label}>
                <IconButton size="small" aria-label={label} onClick={() => browse(target, field)}>
                  <FolderOpenOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }
      : undefined;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          // Opened from inside another form (the folder dialog): keep the submit here.
          event.stopPropagation();
          submit();
        }}
      >
        <DialogTitle sx={{ pb: 0.75 }}>
          {source ? `Edit “${source.name}”` : 'Connect a password manager'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.25} sx={{ pt: 1 }}>
            <TextField
              select
              label="Password manager"
              value={kind}
              // A connected manager keeps its kind: its entries are referenced by it.
              disabled={!!source}
              onChange={(event) => {
                setKind(event.target.value as PasswordManagerKind);
                setConfig({});
              }}
              fullWidth
            >
              {PASSWORD_MANAGER_KINDS.map((option) => (
                <MenuItem key={option} value={option}>
                  {PASSWORD_MANAGER_LABELS[option]}
                  {installed.includes(option) ? null : (
                    <Box component="span" sx={{ ml: 1.5, color: 'text.secondary', fontSize: 13 }}>
                      {KIND_NOTES[option].program} not found
                    </Box>
                  )}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2" color="textSecondary">
              {notes.note}
            </Typography>

            {kind === 'keepass' ? (
              <>
                <TextField
                  label="Database file"
                  value={config.path ?? ''}
                  onChange={(event) => set({ path: event.target.value })}
                  placeholder="~/Passwords.kdbx"
                  slotProps={{ input: browseButton('database', 'path', 'Browse for the database') }}
                  inputRef={focusRef}
                  fullWidth
                />
                <TextField
                  label="Key file"
                  value={config.keyFile ?? ''}
                  onChange={(event) => set({ keyFile: event.target.value })}
                  helperText="Only when the database is protected with one."
                  slotProps={{ input: browseButton('key-file', 'keyFile', 'Browse for the key file') }}
                  fullWidth
                />
              </>
            ) : null}

            {kind === 'pass' ? (
              <TextField
                label="Password store folder"
                value={config.path ?? ''}
                onChange={(event) => set({ path: event.target.value })}
                placeholder="~/.password-store"
                helperText="Leave empty for the default store. gopass keeps its own under ~/.local/share/gopass/stores/root."
                slotProps={{ input: browseButton('store', 'path', 'Browse for the store folder') }}
                fullWidth
              />
            ) : null}

            {kind === 'onepassword' ? (
              <TextField
                label="Account"
                value={config.account ?? ''}
                onChange={(event) => set({ account: event.target.value })}
                placeholder="my.1password.com"
                helperText="Sign-in address or account ID. Only needed when the app has several accounts."
                fullWidth
              />
            ) : null}

            {notes.program ? (
              <TextField
                label={`Path to ${notes.program}`}
                value={config.program ?? ''}
                onChange={(event) => set({ program: event.target.value })}
                placeholder={notes.program}
                helperText={
                  missingProgram
                    ? `${notes.program} was not found on this computer. Install it, or enter where it is.`
                    : 'Leave empty to find it on PATH.'
                }
                error={missingProgram}
                fullWidth
              />
            ) : null}

            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={PASSWORD_MANAGER_LABELS[kind]}
              helperText="Shown wherever an entry from it is used."
              fullWidth
            />

            {save.isError ? (
              <Alert severity="error" variant="outlined">
                {save.error instanceof Error ? save.error.message : 'Could not save the password manager.'}
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={incomplete || save.isPending}>
            {source ? 'Save' : 'Connect'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
