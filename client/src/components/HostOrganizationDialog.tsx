import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import { useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useUpdateSshMetadata } from '../api/ssh-config.js';
import { hostAddress, hostDisplayName } from '../host-organization.js';
import { knownHostGroups } from '../managed-hosts.js';
import { savedHostAddress, savedHostDisplayName } from '../saved-hosts.js';
import { useUiStore } from '../state/ui.js';
import { HostColorPicker } from './HostColorPicker.js';
import { hostKindIcon } from './host-kind-icon.js';

/** Edit presentation metadata without changing a host's connection details. */
export function HostOrganizationDialog() {
  const entry = useUiStore((state) => state.hostOrganizer);
  const setEntry = useUiStore((state) => state.setHostOrganizer);
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const [displayName, setDisplayName] = useState('');
  const [group, setGroup] = useState('');
  const [color, setColor] = useState<string | undefined>();
  const updateMetadata = useUpdateSshMetadata(() => setEntry(false));
  const updateProfileMetadata = useUpdateHostProfileMetadata(() => setEntry(false));

  useEffect(() => {
    if (!entry) return;
    setDisplayName(entry.metadata?.displayName ?? '');
    setGroup(entry.metadata?.group ?? '');
    setColor(entry.metadata?.color);
  }, [entry]);

  const groups = useMemo(
    () => knownHostGroups(config?.hosts ?? [], savedData?.profiles ?? []),
    [config?.hosts, savedData?.profiles],
  );

  if (!entry) return null;

  const saved = isSavedHost(entry);
  const PreviewIcon = hostKindIcon(saved ? entry.kind : 'ssh');
  const fallbackName = saved ? entry.name : entry.alias;
  const name = displayName.trim() || fallbackName;
  const close = () => setEntry(false);
  const patch = {
    displayName: displayName.trim() || null,
    group: group.trim() || null,
    color: color ?? null,
  };
  const save = () => {
    if (saved) {
      updateProfileMetadata.mutate({ id: entry.id, patch });
    } else {
      updateMetadata.mutate({ alias: entry.alias, patch });
    }
  };

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <DialogTitle sx={{ pb: 0.75 }}>Organize {managedHostName(entry)}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Display name, group, and color are local to Muxus. Connection settings
            stay unchanged.
          </Typography>

          <Stack spacing={2.25}>
            <TextField
              label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={fallbackName}
              helperText="Optional — only changes how this host appears in Muxus."
              fullWidth
            />
            <Autocomplete
              freeSolo
              options={groups}
              value={group}
              onInputChange={(_event, value) => setGroup(value)}
              onChange={(_event, value) => setGroup(value ?? '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Group"
                  placeholder="e.g. Production"
                  helperText="Choose an existing group or type a new one."
                />
              )}
            />
            <HostColorPicker value={color} onChange={setColor} />

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                p: 1.25,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
                bgcolor: 'sidebar',
                borderLeft: 4,
                borderLeftColor: color ?? 'divider',
              }}
            >
              <PreviewIcon sx={{ color: color ?? 'text.secondary' }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {group.trim() ? `${group.trim()} · ` : ''}
                  {managedHostAddress(entry)}
                </Typography>
              </Box>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={updateMetadata.isPending || updateProfileMetadata.isPending}
          >
            Save
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function isSavedHost(
  entry: SshHostEntry | SavedHostProfile,
): entry is SavedHostProfile {
  return 'id' in entry && 'profile' in entry;
}

function managedHostName(entry: SshHostEntry | SavedHostProfile): string {
  return isSavedHost(entry)
    ? savedHostDisplayName(entry)
    : hostDisplayName(entry);
}

function managedHostAddress(entry: SshHostEntry | SavedHostProfile): string {
  if (!isSavedHost(entry)) return hostAddress(entry);
  return savedHostAddress(entry);
}
