import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import BoltIcon from '@mui/icons-material/Bolt';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { SshHostEntry } from '@muxus/shared';
import { useSshConfig } from '../api/queries.js';
import { useDeleteHost, useUpdateSshMetadata } from '../api/ssh-config.js';
import { copyToClipboard } from '../clipboard.js';
import { groupHosts, hostAddress, hostDisplayName } from '../host-organization.js';
import { connectHost, connectTarget, isQuickConnectTarget, openLocalTerminal } from '../session-actions.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { layout } from '../theme.js';

const EMPTY_HOSTS: SshHostEntry[] = [];

/**
 * Live OpenSSH hosts enriched with Muxus-owned favorites/recent metadata.
 * Editing connection details still writes directly back to ssh_config.
 */
export function SessionSidebar() {
  const { data: config } = useSshConfig();
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setHostOrganizer = useUiStore((s) => s.setHostOrganizer);
  const tabs = useTabsStore((s) => s.tabs);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ anchor: HTMLElement; position?: { top: number; left: number }; entry: SshHostEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SshHostEntry | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const deleteHost = useDeleteHost(() => setConfirmDelete(null));
  const updateMetadata = useUpdateSshMetadata();

  const needle = filter.trim().toLowerCase();
  const hosts = config?.hosts ?? EMPTY_HOSTS;

  const groups = useMemo(
    () => groupHosts(hosts, config?.files ?? [], config?.path, needle),
    [hosts, config?.files, config?.path, needle],
  );
  const visible = groups.flatMap((group) => group.hosts);

  /** Live session dots: connected/connecting tab counts per primary alias. */
  const liveByTarget = useMemo(() => {
    const map = new Map<string, { connected: number; connecting: number }>();
    for (const t of tabs) {
      if (t.profile.kind !== 'ssh') continue;
      const entry = map.get(t.profile.target) ?? { connected: 0, connecting: 0 };
      if (t.status === 'connected') entry.connected++;
      if (t.status === 'connecting') entry.connecting++;
      map.set(t.profile.target, entry);
    }
    return map;
  }, [tabs]);

  const quickConnectable = !!needle && isQuickConnectTarget(filter) && !hosts.some((h) => h.aliases.includes(filter.trim()));

  const onEnter = () => {
    if (visible.length > 0) connectHost(visible[0]!);
    else if (quickConnectable) connectTarget(filter.trim());
    else return;
    setFilter('');
  };

  const openMenu = (entry: SshHostEntry, anchor: HTMLElement, position?: { top: number; left: number }) =>
    setMenu({ anchor, position, entry });

  return (
    <Box
      sx={{
        width: layout.sidebarWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        borderRight: 1,
        borderColor: 'divider',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ p: 1.25, pb: 0.75, alignItems: 'center' }}>
        <TextField
          fullWidth
          placeholder="Search / user@host ⏎"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter();
            if (e.key === 'Escape') setFilter('');
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
        <Tooltip title="Add host to ~/.ssh/config">
          <IconButton size="small" aria-label="Add SSH host" onClick={() => setHostEditor({ mode: 'new' })}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
        <List dense disablePadding>
          <ListItemButton onClick={() => openLocalTerminal()}>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <TerminalIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Local terminal" />
          </ListItemButton>
          {quickConnectable && (
            <ListItemButton
              onClick={() => {
                connectTarget(filter.trim());
                setFilter('');
              }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                <BoltIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText primary={`Connect to ${filter.trim()}`} slotProps={{ primary: { sx: { color: 'primary.main' } } }} />
            </ListItemButton>
          )}
        </List>

        {config?.error && (
          <Alert severity="warning" sx={{ mx: 1, my: 0.5, py: 0, fontSize: 12 }}>
            {config.error}
          </Alert>
        )}

        {groups.map((group) => (
          <List
            key={group.key}
            dense
            disablePadding
            subheader={
              <ListSubheader
                disableSticky
                onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))}
                sx={{
                  bgcolor: 'transparent',
                  lineHeight: '28px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  cursor: 'pointer',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                }}
              >
                {collapsed[group.key] ? <ExpandMoreIcon sx={{ fontSize: 14 }} /> : <ExpandLessIcon sx={{ fontSize: 14 }} />}
                {group.kind === 'custom' && <FolderOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled' }} />}
                <Tooltip title={group.tooltip ?? group.label}>
                  <span>{group.label}</span>
                </Tooltip>
                <Typography component="span" sx={{ fontSize: 11, color: 'text.disabled', ml: 'auto', mr: 0.5 }}>
                  {group.hosts.length}
                </Typography>
              </ListSubheader>
            }
          >
            {!collapsed[group.key] &&
              group.hosts.map((h) => (
                <HostRow
                  key={`${h.file}:${h.alias}`}
                  entry={h}
                  live={liveByTarget.get(h.alias)}
                  onConnect={() => connectHost(h)}
                  onMenu={openMenu}
                />
              ))}
          </List>
        ))}

        {hosts.length === 0 && (
          <Stack spacing={1.5} sx={{ alignItems: 'center', p: 3, textAlign: 'center' }}>
            <DnsOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">
              No hosts in ~/.ssh/config yet.
            </Typography>
            <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setHostEditor({ mode: 'new' })}>
              Add your first host
            </Button>
          </Stack>
        )}
        {hosts.length > 0 && visible.length === 0 && !quickConnectable && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>
            No hosts match.
          </Typography>
        )}
      </Box>

      <Menu
        open={!!menu}
        anchorEl={menu?.position ? undefined : menu?.anchor}
        anchorReference={menu?.position ? 'anchorPosition' : 'anchorEl'}
        anchorPosition={menu?.position}
        onClose={() => setMenu(null)}
      >
        <MenuItem
          onClick={() => {
            if (menu) connectHost(menu.entry);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PlayArrowOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Connect
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) {
              updateMetadata.mutate({
                alias: menu.entry.alias,
                patch: { favorite: !(menu.entry.metadata?.favorite ?? false) },
              });
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            {menu?.entry.metadata?.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </ListItemIcon>
          {menu?.entry.metadata?.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setHostOrganizer(menu.entry);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PaletteOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Organize & color…
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setHostEditor({ mode: 'edit', entry: menu.entry });
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit host
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setHostEditor({ mode: 'duplicate', entry: menu.entry });
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <LibraryAddOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Duplicate
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) {
              void copyToClipboard(`ssh ${menu.entry.alias}`).then((ok) => {
                if (ok) showToast('success', `Copied "ssh ${menu.entry.alias}"`);
              });
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          Copy ssh command
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            if (menu) setConfirmDelete(menu.entry);
            setMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'error.main' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          Delete host
        </MenuItem>
      </Menu>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete “{confirmDelete?.alias}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            The Host block is removed from {confirmDelete ? shortenPath(confirmDelete.file) : ''}. A backup of the previous file is
            kept next to it as config.muxus.bak.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deleteHost.isPending} onClick={() => confirmDelete && deleteHost.mutate(confirmDelete.alias)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function shortenPath(p: string): string {
  return p.replace(/^.*(\/\.ssh\/)/, '~/.ssh/');
}

function HostRow({
  entry,
  live,
  onConnect,
  onMenu,
}: {
  entry: SshHostEntry;
  live?: { connected: number; connecting: number };
  onConnect: () => void;
  onMenu: (entry: SshHostEntry, anchor: HTMLElement, position?: { top: number; left: number }) => void;
}) {
  const r = entry.resolved;
  const secondary = hostAddress(entry);
  const badge = { fontSize: 14, color: 'text.disabled' } as const;

  const row = (
    <ListItemButton
      onClick={onConnect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(entry, e.currentTarget, { top: e.clientY, left: e.clientX });
      }}
      sx={{
        '&:hover .host-row-menu': { opacity: 1 },
        pr: 0.5,
        borderLeft: 3,
        borderLeftColor: entry.metadata?.color ?? 'transparent',
      }}
    >
      <ListItemIcon sx={{ minWidth: 32 }}>
        {r.proxyJump.length > 0 ? (
          <AltRouteIcon fontSize="small" sx={{ color: entry.metadata?.color ?? 'text.secondary' }} />
        ) : (
          <DnsOutlinedIcon fontSize="small" sx={{ color: entry.metadata?.color ?? 'text.secondary' }} />
        )}
      </ListItemIcon>
      <ListItemText
        primary={
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            {(live?.connected ?? 0) + (live?.connecting ?? 0) > 0 && (
              <Box
                sx={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: live!.connected > 0 ? 'success.main' : 'warning.main',
                  ...(live!.connected === 0 && {
                    animation: 'muxus-pulse 1.2s ease-in-out infinite',
                    '@keyframes muxus-pulse': { '50%': { opacity: 0.3 } },
                  }),
                }}
              />
            )}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hostDisplayName(entry)}
            </Box>
            {entry.metadata?.favorite && <StarIcon sx={{ fontSize: 13, color: 'warning.main' }} />}
            {(live?.connected ?? 0) > 1 && (
              <Typography component="span" sx={{ fontSize: 10, color: 'success.main' }}>
                ×{live!.connected}
              </Typography>
            )}
          </Stack>
        }
        secondary={secondary !== entry.alias ? secondary : undefined}
        slotProps={{ secondary: { sx: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } } }}
      />
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0, mr: 0.25 }}>
        {r.proxyJump.length > 0 && (
          <Tooltip title={`via ${r.proxyJump.join(' → ')}`}>
            <AltRouteIcon sx={badge} />
          </Tooltip>
        )}
        {r.identityFiles.length > 0 && (
          <Tooltip title={r.identityFiles.map((f) => f.split(/[\\/]/).pop()).join(', ')}>
            <KeyOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        {r.passwordOnly && (
          <Tooltip title="Password authentication">
            <PasswordOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        {r.forwards.length > 0 && (
          <Tooltip title={`${r.forwards.length} port forward${r.forwards.length > 1 ? 's' : ''} on connect`}>
            <SwapHorizOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        <IconButton
          className="host-row-menu"
          size="small"
          edge="end"
          aria-label={`Options for ${entry.alias}`}
          sx={{ opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms' }}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(entry, e.currentTarget);
          }}
        >
          <Box component="span" sx={{ fontSize: 16, lineHeight: 1 }}>
            ⋮
          </Box>
        </IconButton>
      </Stack>
    </ListItemButton>
  );

  return entry.description ? (
    <Tooltip title={entry.description} placement="right" enterDelay={600}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}
