import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import {
  groupManagedHosts,
  managedHostAddress,
  managedHostDisplayName,
  managedHostKey,
  type ManagedHost,
} from '../managed-hosts.js';
import { connectManagedHost } from '../session-actions.js';
import { loadHostEditorDialog, loadTerminalViewImpl } from '../lazy-features.js';
import { useUiStore } from '../state/ui.js';
import { hostKindIcon } from './host-kind-icon.js';
import { TruncationTooltip } from './TruncationTooltip.js';

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
  const { data: savedData } = useSavedHostProfiles();
  const setHostEditor = useUiStore((state) => state.setHostEditor);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const searchInput = useRef<HTMLInputElement>(null);
  const groups = useMemo(
    () =>
      groupManagedHosts(
        config?.hosts ?? [],
        savedData?.profiles ?? [],
        config?.files ?? [],
        config?.path,
        deferredFilter,
      ),
    [
      config?.hosts,
      savedData?.profiles,
      config?.files,
      config?.path,
      deferredFilter,
    ],
  );
  const visible = groups.flatMap((group) => group.hosts);

  useEffect(() => {
    if (!anchorEl) {
      setFilter('');
      return;
    }
    // Keyboard users may press Enter without ever hovering a host row. Start
    // the lazy terminal chunk while they choose a host so connection startup
    // does not wait behind code loading.
    void loadTerminalViewImpl();
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [anchorEl]);

  const connectFirst = () => {
    const host = groupManagedHosts(
      config?.hosts ?? [],
      savedData?.profiles ?? [],
      config?.files ?? [],
      config?.path,
      filter,
    ).flatMap((group) => group.hosts)[0];
    if (!host) return;
    connectManagedHost(host, replaceTabId);
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
            if (event.key === 'Enter') connectFirst();
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
                {/* Stays a flat picker rather than a tree — it is a compact
                    popover — but a nested group still reads as a path. */}
                {group.label.split('/').join(' / ')}
              </ListSubheader>
            }
          >
            {group.hosts.map((host) => (
              <HostPickerRow
                key={managedHostKey(host)}
                host={host}
                replaceTabId={replaceTabId}
                onClose={onClose}
              />
            ))}
          </List>
        ))}
        {visible.length === 0 && (
          <Stack spacing={0.75} sx={{ px: 2, py: 3, alignItems: 'center', textAlign: 'center' }}>
            <DnsOutlinedIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">
              {(config?.hosts.length ?? 0) + (savedData?.profiles.length ?? 0) === 0
                ? 'No saved hosts yet.'
                : 'No hosts match your search.'}
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
          onMouseEnter={() => void loadHostEditorDialog()}
          onFocus={() => void loadHostEditorDialog()}
          onClick={() => {
            onClose();
            setHostEditor({ mode: 'new' });
          }}
        >
          Add host
        </Button>
      </Box>
    </Popover>
  );
}

function HostPickerRow({
  host,
  replaceTabId,
  onClose,
}: {
  host: ManagedHost;
  replaceTabId?: string;
  onClose: () => void;
}) {
  const title = managedHostDisplayName(host);
  const address = managedHostAddress(host);
  const metadata = host.entry.metadata;
  const Icon = hostKindIcon(host.kind === 'ssh' ? 'ssh' : host.entry.kind);

  return (
    <ListItemButton
      onMouseEnter={() => void loadTerminalViewImpl()}
      onFocus={() => void loadTerminalViewImpl()}
      onClick={() => {
        connectManagedHost(host, replaceTabId);
        onClose();
      }}
      sx={{ contentVisibility: 'auto', containIntrinsicSize: '0 48px' }}
    >
      <ListItemIcon sx={{ minWidth: 34 }}>
        <Icon sx={{ fontSize: 19, color: metadata?.color ?? 'text.secondary' }} />
      </ListItemIcon>
      <ListItemText
        primary={
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <TruncationTooltip text={title}>
              <Typography variant="body2" noWrap sx={{ minWidth: 0, fontWeight: 550 }}>
                {title}
              </Typography>
            </TruncationTooltip>
            {metadata?.favorite && (
              <StarIcon
                sx={{ fontSize: 12, color: 'warning.main', flexShrink: 0 }}
              />
            )}
          </Stack>
        }
        secondary={address}
        slotProps={{ secondary: { noWrap: true, sx: { fontSize: 11 } } }}
      />
    </ListItemButton>
  );
}
