import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { PASSWORD_MANAGER_LABELS, type PasswordManagerSource } from '@muxus/shared';
import {
  useDeletePasswordManager,
  useLockPasswordManager,
  usePasswordManagers,
} from '../api/password-managers.js';
import { confirmAction } from '../state/dialogs.js';
import { SettingsGroup, StatusText, type StatusTone } from './SettingsLayout.js';
import { PasswordManagerDialog } from './password-managers/PasswordManagerDialog.js';
import { PasswordManagerUnlockForm, unlocksInMuxus } from './password-managers/PasswordManagerUnlockForm.js';

/** Settings → Passwords: the password managers Muxus reads login passwords from. */
export function PasswordManagersGroup() {
  const managers = usePasswordManagers();
  const remove = useDeletePasswordManager();
  const lock = useLockPasswordManager();
  const [editing, setEditing] = useState<{ source?: PasswordManagerSource } | undefined>();
  const [unlocking, setUnlocking] = useState<string | undefined>();
  const sources = managers.data?.sources ?? [];
  const unlockSource = sources.find((source) => source.id === unlocking);

  const disconnect = async (source: PasswordManagerSource) => {
    const confirmed = await confirmAction({
      title: `Disconnect “${source.name}”?`,
      description:
        'Hosts and folders that use an entry from it will ask for their password again. Nothing changes in the password manager itself.',
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (confirmed) remove.mutate(source.id);
  };

  return (
    <>
      <SettingsGroup
        title={sources.length ? `Password managers · ${sources.length}` : 'Password managers'}
        description="Log in with passwords kept in KeePass, 1Password, Bitwarden, Proton Pass, LastPass, Dashlane or pass. Pick an entry in a host's Authentication settings or in a folder's shared credentials. Muxus stores which entry to use, never the password, and reads it from the manager each time."
        action={
          <Button size="small" startIcon={<AddIcon />} onClick={() => setEditing({})}>
            Connect
          </Button>
        }
        flush
      >
        {sources.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            {managers.isLoading ? 'Loading…' : 'None connected.'}
          </Typography>
        ) : (
          sources.map((source) => {
            const state = sourceState(source);
            return (
              <Box
                key={source.id}
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
                  <Typography variant="body2" noWrap sx={{ fontWeight: 550 }} title={source.name}>
                    {source.name}
                  </Typography>
                  <Typography variant="caption" color="textSecondary" component="div" noWrap>
                    {[PASSWORD_MANAGER_LABELS[source.kind], source.config.path ?? source.config.account]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                  <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
                    <StatusText tone={state.tone}>{state.text}</StatusText>
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0, alignItems: 'center' }}>
                  {source.state === 'locked' && unlocksInMuxus(source) ? (
                    <Button size="small" onClick={() => setUnlocking(source.id)}>
                      Unlock
                    </Button>
                  ) : null}
                  {source.state === 'ready' && unlocksInMuxus(source) ? (
                    <Button
                      size="small"
                      disabled={lock.isPending}
                      onClick={() => lock.mutate(source.id)}
                    >
                      Lock
                    </Button>
                  ) : null}
                  {source.state === 'signed-out' || source.state === 'unavailable' ? (
                    <Button size="small" onClick={() => void managers.refetch()}>
                      Check again
                    </Button>
                  ) : null}
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${source.name}`} onClick={() => setEditing({ source })}>
                      <EditOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Disconnect">
                    <IconButton
                      size="small"
                      aria-label={`Disconnect ${source.name}`}
                      onClick={() => void disconnect(source)}
                    >
                      <DeleteOutlineIcon color="error" sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Box>
            );
          })
        )}
      </SettingsGroup>

      {editing ? (
        <PasswordManagerDialog
          source={editing.source}
          installed={managers.data?.installed ?? []}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      {unlockSource ? (
        <Dialog open onClose={() => setUnlocking(undefined)} maxWidth="xs" fullWidth>
          <DialogTitle sx={{ pb: 0.75 }}>Unlock “{unlockSource.name}”</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 1 }}>
              <PasswordManagerUnlockForm source={unlockSource} onUnlocked={() => setUnlocking(undefined)} />
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setUnlocking(undefined)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </>
  );
}

function sourceState(source: PasswordManagerSource): { tone: StatusTone; text: string } {
  switch (source.state) {
    case 'ready':
      return { tone: 'success', text: unlocksInMuxus(source) ? 'Unlocked' : 'Ready' };
    case 'locked':
      return { tone: 'info', text: source.message ?? 'Locked' };
    case 'signed-out':
      return { tone: 'warning', text: source.message ?? 'Not signed in' };
    default:
      return { tone: 'error', text: source.message ?? 'Unavailable' };
  }
}
