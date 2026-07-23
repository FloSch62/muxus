import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import { useSshConfig } from '../api/queries.js';
import { useUpdateSshMetadata } from '../api/ssh-config.js';
import { HOST_COLORS, hostAddress, hostDisplayName } from '../host-organization.js';
import { useUiStore } from '../state/ui.js';

/** Edit presentation metadata without touching the OpenSSH Host block. */
export function HostOrganizationDialog() {
  const entry = useUiStore((state) => state.hostOrganizer);
  const setEntry = useUiStore((state) => state.setHostOrganizer);
  const { data: config } = useSshConfig();
  const [displayName, setDisplayName] = useState('');
  const [group, setGroup] = useState('');
  const [color, setColor] = useState<string | undefined>();
  const updateMetadata = useUpdateSshMetadata(() => setEntry(false));

  useEffect(() => {
    if (!entry) return;
    setDisplayName(entry.metadata?.displayName ?? '');
    setGroup(entry.metadata?.group ?? '');
    setColor(entry.metadata?.color);
  }, [entry]);

  const groups = useMemo(
    () =>
      [...new Set((config?.hosts ?? []).map((host) => host.metadata?.group).filter((value): value is string => !!value))]
        .sort((a, b) => a.localeCompare(b)),
    [config?.hosts],
  );

  if (!entry) return null;

  const name = displayName.trim() || entry.alias;
  const close = () => setEntry(false);
  const save = () =>
    updateMetadata.mutate({
      alias: entry.alias,
      patch: {
        displayName: displayName.trim() || null,
        group: group.trim() || null,
        color: color ?? null,
      },
    });

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <DialogTitle sx={{ pb: 0.75 }}>Organize {hostDisplayName(entry)}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Group and color are local to Muxus. Your SSH config stays unchanged.
          </Typography>

          <Stack spacing={2.25}>
            <TextField
              label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={entry.alias}
              helperText="Optional — the SSH alias still works everywhere."
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
            <Box>
              <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
                Color
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Tooltip title="No color">
                  <ButtonBase
                    aria-label="No host color"
                    onClick={() => setColor(undefined)}
                    sx={{
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      border: 1,
                      borderColor: color ? 'divider' : 'text.secondary',
                    }}
                  >
                    {!color && <CheckIcon sx={{ fontSize: 17, color: 'text.secondary' }} />}
                  </ButtonBase>
                </Tooltip>
                {HOST_COLORS.map((swatch) => (
                  <Tooltip key={swatch.value} title={swatch.name}>
                    <ButtonBase
                      aria-label={`${swatch.name} host color`}
                      onClick={() => setColor(swatch.value)}
                      sx={{
                        width: 30,
                        height: 30,
                        borderRadius: '50%',
                        bgcolor: swatch.value,
                        boxShadow: color === swatch.value ? (theme) => `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${swatch.value}` : undefined,
                        '&:hover': { transform: 'scale(1.08)' },
                        transition: 'transform 120ms ease',
                      }}
                    >
                      {color === swatch.value && <CheckIcon sx={{ fontSize: 17, color: 'rgba(0,0,0,0.68)' }} />}
                    </ButtonBase>
                  </Tooltip>
                ))}
              </Stack>
            </Box>

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
              <DnsOutlinedIcon sx={{ color: color ?? 'text.secondary' }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {group.trim() ? `${group.trim()} · ` : ''}
                  {hostAddress(entry)}
                </Typography>
              </Box>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={updateMetadata.isPending}>
            Save
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
