import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import { useSshConfig } from '../api/queries.js';
import { groupHosts, hostAddress, hostDisplayName } from '../host-organization.js';
import { connectHost } from '../session-actions.js';
import { useUiStore } from '../state/ui.js';

export function HostPickerPopover({
  anchorEl,
  onClose,
  replaceTabId,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  replaceTabId?: string;
}) {
  const { data: config } = useSshConfig();
  const setHostEditor = useUiStore((state) => state.setHostEditor);
  const [filter, setFilter] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const groups = useMemo(
    () => groupHosts(config?.hosts ?? [], config?.files ?? [], config?.path, filter),
    [config?.hosts, config?.files, config?.path, filter],
  );
  const visible = groups.flatMap((group) => group.hosts);

  useEffect(() => {
    if (!anchorEl) {
      setFilter('');
      return;
    }
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [anchorEl]);

  const connect = (index: number) => {
    const host = visible[index];
    if (!host) return;
    connectHost(host, replaceTabId);
    onClose();
  };

  return (
    <Popover
      open={!!anchorEl}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 24px)', mt: 0.75, overflow: 'hidden' } } }}
    >
      <Box sx={{ p: 1.25, pb: 1 }}>
        <Typography variant="subtitle2" sx={{ px: 0.25, mb: 1 }}>
          Connect to a host
        </Typography>
        <TextField
          inputRef={searchInput}
          fullWidth
          placeholder="Search hosts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible.length > 0) connect(0);
            if (event.key === 'Escape') onClose();
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>
      <Divider />
      <Box sx={{ maxHeight: 380, overflowY: 'auto', py: 0.5 }}>
        {groups.map((group) => (
          <List
            key={group.key}
            dense
            disablePadding
            subheader={
              <ListSubheader
                disableSticky
                sx={{
                  bgcolor: 'background.paper',
                  fontSize: 10.5,
                  lineHeight: '26px',
                  textTransform: 'uppercase',
                  letterSpacing: 0.65,
                  color: 'text.secondary',
                }}
              >
                {group.label}
              </ListSubheader>
            }
          >
            {group.hosts.map((host) => (
              <ListItemButton
                key={`${host.file}:${host.alias}`}
                onClick={() => {
                  connectHost(host, replaceTabId);
                  onClose();
                }}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>
                  <Box sx={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
                    <DnsOutlinedIcon sx={{ fontSize: 19, color: host.metadata?.color ?? 'text.secondary' }} />
                    {host.metadata?.color && (
                      <Box
                        sx={{
                          position: 'absolute',
                          right: -3,
                          bottom: -2,
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          bgcolor: host.metadata.color,
                          border: 1,
                          borderColor: 'background.paper',
                        }}
                      />
                    )}
                  </Box>
                </ListItemIcon>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 550 }}>
                        {hostDisplayName(host)}
                      </Typography>
                      {host.metadata?.favorite && <StarIcon sx={{ fontSize: 12, color: 'warning.main', flexShrink: 0 }} />}
                    </Stack>
                  }
                  secondary={hostAddress(host)}
                  slotProps={{
                    secondary: { noWrap: true, sx: { fontSize: 11 } },
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        ))}
        {visible.length === 0 && (
          <Stack spacing={0.75} sx={{ px: 2, py: 3, alignItems: 'center', textAlign: 'center' }}>
            <DnsOutlinedIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">
              {(config?.hosts.length ?? 0) === 0 ? 'No saved SSH hosts yet.' : 'No hosts match your search.'}
            </Typography>
          </Stack>
        )}
      </Box>
      <Divider />
      <Box sx={{ p: 0.75 }}>
        <Button
          fullWidth
          color="inherit"
          startIcon={<AddIcon />}
          onClick={() => {
            onClose();
            setHostEditor({ mode: 'new' });
          }}
        >
          Add SSH host
        </Button>
      </Box>
    </Popover>
  );
}
