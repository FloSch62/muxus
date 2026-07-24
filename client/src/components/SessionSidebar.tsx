import { useDeferredValue, useMemo, useRef, useState, type DragEvent } from 'react';
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
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { SshHostEntry } from '@muxus/shared';
import { useReorderManagedHosts } from '../api/host-order.js';
import { useDeleteHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useDeleteHost, useUpdateSshMetadata } from '../api/ssh-config.js';
import { copyToClipboard } from '../clipboard.js';
import { hostOrderAfterDrop } from '../host-organization.js';
import {
  groupManagedHosts,
  managedHostAddress,
  managedHostCopyCommand,
  managedHostDisplayName,
  managedHostKey,
  managedHostRef,
  type ManagedHost,
} from '../managed-hosts.js';
import {
  connectManagedHost,
  connectTarget,
  isQuickConnectTarget,
  openLocalTerminal,
  openManagedHostInNewWindow,
} from '../session-actions.js';
import {
  loadHostEditorDialog,
  loadHostOrganizationDialog,
  loadTerminalViewImpl,
} from '../lazy-features.js';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from '../sidebar-width.js';
import { usePrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { hostKindIcon } from './host-kind-icon.js';
import { PanelResizeHandle } from './PanelResizeHandle.js';
import { TruncationTooltip } from './TruncationTooltip.js';

const EMPTY_HOSTS: SshHostEntry[] = [];
type LiveCounts = { connected: number; connecting: number };
type DropTarget =
  | { kind: 'row'; groupKey: string; hostKey: string; edge: 'before' | 'after' }
  | { kind: 'group'; groupKey: string };

/** Saved Telnet/serial profiles and live OpenSSH hosts in one host manager. */
export function SessionSidebar() {
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setHostOrganizer = useUiStore((s) => s.setHostOrganizer);
  const tabs = useTabsStore((s) => s.tabs);
  const sidebarWidth = usePrefsStore((state) => state.sidebarWidth);
  const setPrefs = usePrefsStore((state) => state.set);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ anchor: HTMLElement; position?: { top: number; left: number }; host: ManagedHost } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ManagedHost | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragged, setDragged] = useState<{ groupKey: string; hostKey: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const deleteHost = useDeleteHost(() => setConfirmDelete(null));
  const deleteProfile = useDeleteHostProfile(() => setConfirmDelete(null));
  const updateMetadata = useUpdateSshMetadata();
  const updateProfileMetadata = useUpdateHostProfileMetadata();
  const reorder = useReorderManagedHosts();

  const normalizedFilter = filter.trim().toLowerCase();
  const needle = useDeferredValue(normalizedFilter);
  const hosts = config?.hosts ?? EMPTY_HOSTS;
  const groups = useMemo(
    () =>
      groupManagedHosts(
        hosts,
        savedData?.profiles ?? [],
        config?.files ?? [],
        config?.path,
        needle,
      ),
    [hosts, savedData?.profiles, config?.files, config?.path, needle],
  );
  const immediateGroups = useMemo(
    () =>
      groupManagedHosts(
        hosts,
        savedData?.profiles ?? [],
        config?.files ?? [],
        config?.path,
        normalizedFilter,
      ),
    [hosts, savedData?.profiles, config?.files, config?.path, normalizedFilter],
  );
  const visible = groups.flatMap((group) => group.hosts);
  const hostByKey = useMemo(
    () => new Map(visible.map((host) => [managedHostKey(host), host])),
    [visible],
  );
  const menuGroup = menu
    ? groups.find((group) =>
        group.hosts.some((host) => managedHostKey(host) === managedHostKey(menu.host)),
      )
    : undefined;
  const menuIndex =
    menu && menuGroup
      ? menuGroup.hosts.findIndex(
          (host) => managedHostKey(host) === managedHostKey(menu.host),
        )
      : -1;

  const mutating =
    reorder.isPending || updateMetadata.isPending || updateProfileMetadata.isPending;

  const commitOrder = (keys: readonly string[]) =>
    reorder.mutate(
      keys.flatMap((key) => {
        const host = hostByKey.get(key);
        return host ? [managedHostRef(host)] : [];
      }),
    );

  const reorderWithin = (groupKey: string, sourceKey: string, targetKey: string, edge: 'before' | 'after') => {
    const group = groups.find((candidate) => candidate.key === groupKey);
    if (!group || sourceKey === targetKey) return;
    const keys = group.hosts.map(managedHostKey);
    const next = hostOrderAfterDrop(keys, sourceKey, targetKey, edge);
    if (next.every((key, index) => key === keys[index])) return;
    commitOrder(next);
  };

  const moveToGroup = (
    targetGroupKey: string,
    sourceKey: string,
    targetKey?: string,
    edge: 'before' | 'after' = 'after',
  ) => {
    const targetGroup = groups.find((candidate) => candidate.key === targetGroupKey);
    const source = hostByKey.get(sourceKey);
    if (!targetGroup || targetGroup.kind !== 'custom' || !source) return;
    const keys = targetGroup.hosts.map(managedHostKey);
    const next = hostOrderAfterDrop(keys, sourceKey, targetKey, edge);
    if (targetGroup.hosts.some((host) => managedHostKey(host) === sourceKey)) {
      if (!next.every((key, index) => key === keys[index])) commitOrder(next);
      return;
    }
    const patch = { group: targetGroup.label };
    const moved =
      source.kind === 'ssh'
        ? updateMetadata.mutateAsync({ alias: source.entry.alias, patch })
        : updateProfileMetadata.mutateAsync({ id: source.entry.id, patch });
    void moved.then(() => commitOrder(next)).catch(() => undefined);
  };

  const moveBy = (groupKey: string, hostKey: string, delta: -1 | 1) => {
    const group = groups.find((candidate) => candidate.key === groupKey);
    if (!group) return;
    const keys = group.hosts.map(managedHostKey);
    const from = keys.indexOf(hostKey);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= keys.length) return;
    [keys[from], keys[to]] = [keys[to]!, keys[from]!];
    commitOrder(keys);
  };

  const beginDrag = (event: DragEvent<HTMLElement>, groupKey: string, hostKey: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', hostKey);
    setDragged({ groupKey, hostKey });
    setDropTarget(null);
  };

  const dragOver = (event: DragEvent<HTMLElement>, groupKey: string, hostKey: string) => {
    if (!dragged) return;
    const targetGroup = groups.find((candidate) => candidate.key === groupKey);
    if (
      dragged.hostKey === hostKey ||
      !targetGroup ||
      (dragged.groupKey !== groupKey && targetGroup.kind !== 'custom')
    ) {
      setDropTarget((current) => (current ? null : current));
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropTarget((current) =>
      current?.kind === 'row' &&
      current.groupKey === groupKey &&
      current.hostKey === hostKey &&
      current.edge === edge
        ? current
        : { kind: 'row', groupKey, hostKey, edge },
    );
  };

  const drop = (event: DragEvent<HTMLElement>, groupKey: string, hostKey: string) => {
    event.preventDefault();
    if (
      dragged &&
      dropTarget?.kind === 'row' &&
      dropTarget.groupKey === groupKey &&
      dropTarget.hostKey === hostKey
    ) {
      if (dragged.groupKey === groupKey) reorderWithin(groupKey, dragged.hostKey, hostKey, dropTarget.edge);
      else moveToGroup(groupKey, dragged.hostKey, hostKey, dropTarget.edge);
    }
    setDragged(null);
    setDropTarget(null);
  };

  const dragOverGroup = (event: DragEvent<HTMLElement>, groupKey: string) => {
    const group = groups.find((candidate) => candidate.key === groupKey);
    if (!dragged) return;
    if (!group || group.kind !== 'custom') {
      setDropTarget((current) => (current ? null : current));
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget((current) =>
      current?.kind === 'group' && current.groupKey === groupKey
        ? current
        : { kind: 'group', groupKey },
    );
  };

  const dropOnGroup = (event: DragEvent<HTMLElement>, groupKey: string) => {
    event.preventDefault();
    if (dragged && dropTarget?.kind === 'group' && dropTarget.groupKey === groupKey) {
      moveToGroup(groupKey, dragged.hostKey);
    }
    setDragged(null);
    setDropTarget(null);
  };

  /** Live session dots keyed like managedHostKey: connected/connecting tab counts. */
  const liveByKey = useMemo(() => {
    const map = new Map<string, LiveCounts>();
    for (const tab of tabs) {
      if (!tab.profile) continue;
      const key =
        tab.profile.kind === 'ssh'
          ? `ssh:${tab.profile.target}`
          : tab.profile.kind === 'telnet' || tab.profile.kind === 'serial'
            ? tab.profile.profileId && `profile:${tab.profile.profileId}`
            : undefined;
      if (!key) continue;
      const entry = map.get(key) ?? { connected: 0, connecting: 0 };
      if (tab.status === 'connected') entry.connected++;
      if (tab.status === 'connecting') entry.connecting++;
      map.set(key, entry);
    }
    return map;
  }, [tabs]);

  const quickConnectable =
    !!normalizedFilter &&
    isQuickConnectTarget(filter) &&
    immediateGroups.every((group) => group.hosts.length === 0) &&
    !hosts.some((h) => h.aliases.includes(filter.trim()));

  const onEnter = () => {
    const currentMatch = immediateGroups.flatMap((group) => group.hosts)[0];
    if (currentMatch) connectManagedHost(currentMatch);
    else if (quickConnectable) connectTarget(filter.trim());
    else return;
    setFilter('');
  };

  const toggleFavorite = (host: ManagedHost) => {
    const favorite = !(host.entry.metadata?.favorite ?? false);
    if (host.kind === 'ssh') {
      updateMetadata.mutate({ alias: host.entry.alias, patch: { favorite } });
    } else {
      updateProfileMetadata.mutate({ id: host.entry.id, patch: { favorite } });
    }
  };

  const confirmDeleteHost = () => {
    if (!confirmDelete) return;
    if (confirmDelete.kind === 'ssh') deleteHost.mutate(confirmDelete.entry.alias);
    else deleteProfile.mutate(confirmDelete.entry.id);
  };

  const openMenu = (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) =>
    setMenu({ anchor, position, host });

  const copyAction = menu ? managedHostCopyCommand(menu.host) : undefined;

  return (
    <Box
      ref={sidebarRef}
      sx={{
        width: sidebarWidth,
        maxWidth: '45%',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        borderRight: 1,
        borderColor: 'divider',
        position: 'relative',
      }}
    >
      <PanelResizeHandle
        panelRef={sidebarRef}
        edge="right"
        width={sidebarWidth}
        defaultWidth={DEFAULT_SIDEBAR_WIDTH}
        minWidth={MIN_SIDEBAR_WIDTH}
        maxWidth={maxSidebarWidth}
        clampWidth={clampSidebarWidth}
        onWidthChange={(nextSidebarWidth) => setPrefs({ sidebarWidth: nextSidebarWidth })}
        label="Resize sessions sidebar"
      />
      <Stack direction="row" spacing={1} sx={{ p: 1.25, pb: 0.75, alignItems: 'center' }}>
        <TextField
          fullWidth
          placeholder="Search / user@host ⏎"
          value={filter}
          onChange={(e) => {
            const next = e.target.value;
            setFilter(next);
            // Quick-connect commonly goes straight from typing to Enter, so
            // overlap the lazy terminal chunk with the user's input.
            if (next.trim()) void loadTerminalViewImpl();
          }}
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
        <Tooltip title="Add host">
          <IconButton
            size="small"
            aria-label="Add host"
            onMouseEnter={() => void loadHostEditorDialog()}
            onFocus={() => void loadHostEditorDialog()}
            onClick={() => setHostEditor({ mode: 'new' })}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
        <List dense disablePadding>
          <ListItemButton
            onMouseEnter={() => void loadTerminalViewImpl()}
            onFocus={() => void loadTerminalViewImpl()}
            onClick={() => openLocalTerminal()}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <TerminalIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Local terminal" />
          </ListItemButton>
          {quickConnectable && (
            <ListItemButton
              onMouseEnter={() => void loadTerminalViewImpl()}
              onFocus={() => void loadTerminalViewImpl()}
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
                onDragOver={(event) => dragOverGroup(event, group.key)}
                onDragLeave={(event) => {
                  const related = event.relatedTarget;
                  if (related instanceof Node && event.currentTarget.contains(related)) return;
                  setDropTarget((current) =>
                    current?.kind === 'group' && current.groupKey === group.key ? null : current,
                  );
                }}
                onDrop={(event) => dropOnGroup(event, group.key)}
                sx={{
                  bgcolor:
                    dropTarget?.kind === 'group' && dropTarget.groupKey === group.key
                      ? 'action.selected'
                      : 'transparent',
                  lineHeight: '28px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  cursor: 'pointer',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  borderRadius: 1,
                  transition: 'background-color 120ms ease, color 120ms ease, box-shadow 120ms ease',
                  ...(dropTarget?.kind === 'group' &&
                    dropTarget.groupKey === group.key && {
                      color: 'primary.main',
                      boxShadow: (theme) => `inset 3px 0 ${theme.palette.primary.main}`,
                    }),
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
              group.hosts.map((host) => {
                const hostKey = managedHostKey(host);
                return (
                  <HostRow
                    key={hostKey}
                    host={host}
                    live={liveByKey.get(hostKey)}
                    onConnect={() => connectManagedHost(host)}
                    onMenu={openMenu}
                    dragEnabled={!needle && !mutating}
                    dragging={dragged?.groupKey === group.key && dragged.hostKey === hostKey}
                    dropEdge={
                      dropTarget?.kind === 'row' &&
                      dropTarget.groupKey === group.key &&
                      dropTarget.hostKey === hostKey
                        ? dropTarget.edge
                        : undefined
                    }
                    onDragStart={(event) => beginDrag(event, group.key, hostKey)}
                    onDragOver={(event) => dragOver(event, group.key, hostKey)}
                    onDrop={(event) => drop(event, group.key, hostKey)}
                    onDragEnd={() => {
                      setDragged(null);
                      setDropTarget(null);
                    }}
                    onMove={(delta) => moveBy(group.key, hostKey, delta)}
                  />
                );
              })}
          </List>
        ))}

        {hosts.length === 0 && (savedData?.profiles.length ?? 0) === 0 && (
          <Stack spacing={1.5} sx={{ alignItems: 'center', p: 3, textAlign: 'center' }}>
            <DnsOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">
              No saved hosts yet.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onMouseEnter={() => void loadHostEditorDialog()}
              onFocus={() => void loadHostEditorDialog()}
              onClick={() => setHostEditor({ mode: 'new' })}
            >
              Add your first host
            </Button>
          </Stack>
        )}
        {(hosts.length > 0 || (savedData?.profiles.length ?? 0) > 0) &&
          visible.length === 0 &&
          !quickConnectable && (
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
          onMouseEnter={() => void loadTerminalViewImpl()}
          onFocus={() => void loadTerminalViewImpl()}
          onClick={() => {
            if (menu) connectManagedHost(menu.host);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PlayArrowOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Connect
        </MenuItem>
        <MenuItem
          onMouseEnter={() => void loadTerminalViewImpl()}
          onFocus={() => void loadTerminalViewImpl()}
          onClick={() => {
            if (menu) openManagedHostInNewWindow(menu.host);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <OpenInNewOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Open in new window
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) toggleFavorite(menu.host);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            {menu?.host.entry.metadata?.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </ListItemIcon>
          {menu?.host.entry.metadata?.favorite ? 'Remove from favorites' : 'Add to favorites'}
        </MenuItem>
        <MenuItem
          disabled={!!needle || menuIndex <= 0 || mutating}
          onClick={() => {
            if (menu && menuGroup) moveBy(menuGroup.key, managedHostKey(menu.host), -1);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <KeyboardArrowUpIcon fontSize="small" />
          </ListItemIcon>
          Move up
        </MenuItem>
        <MenuItem
          disabled={
            !!needle ||
            !menuGroup ||
            menuIndex < 0 ||
            menuIndex >= menuGroup.hosts.length - 1 ||
            mutating
          }
          onClick={() => {
            if (menu && menuGroup) moveBy(menuGroup.key, managedHostKey(menu.host), 1);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <KeyboardArrowDownIcon fontSize="small" />
          </ListItemIcon>
          Move down
        </MenuItem>
        <Divider />
        <MenuItem
          onMouseEnter={() => void loadHostOrganizationDialog()}
          onFocus={() => void loadHostOrganizationDialog()}
          onClick={() => {
            if (menu) setHostOrganizer(menu.host.entry);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <PaletteOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Organize & color…
        </MenuItem>
        <MenuItem
          onMouseEnter={() => void loadHostEditorDialog()}
          onFocus={() => void loadHostEditorDialog()}
          onClick={() => {
            if (menu) {
              setHostEditor(
                menu.host.kind === 'ssh'
                  ? { mode: 'edit', entry: menu.host.entry }
                  : { mode: 'edit-profile', entry: menu.host.entry },
              );
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit host
        </MenuItem>
        <MenuItem
          onMouseEnter={() => void loadHostEditorDialog()}
          onFocus={() => void loadHostEditorDialog()}
          onClick={() => {
            if (menu) {
              setHostEditor(
                menu.host.kind === 'ssh'
                  ? { mode: 'duplicate', entry: menu.host.entry }
                  : { mode: 'duplicate-profile', entry: menu.host.entry },
              );
            }
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
            if (copyAction) {
              void copyToClipboard(copyAction.text).then((ok) => {
                if (ok) showToast('success', `Copied "${copyAction.text}"`);
              });
            }
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          {copyAction?.label ?? 'Copy'}
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            if (menu) setConfirmDelete(menu.host);
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
        <DialogTitle>Delete “{confirmDelete ? managedHostDisplayName(confirmDelete) : ''}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirmDelete?.kind === 'ssh'
              ? `The Host block is removed from ${shortenPath(confirmDelete.entry.file)}. A backup of the previous file is kept next to it as config.muxus.bak.`
              : 'This removes the saved host from Muxus. It does not change the remote device or serial port.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteHost.isPending || deleteProfile.isPending}
            onClick={confirmDeleteHost}
          >
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

/** One sidebar row for any host source; SSH rows add resolved-config badges. */
function HostRow({
  host,
  live,
  onConnect,
  onMenu,
  dragEnabled,
  dragging,
  dropEdge,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
}: {
  host: ManagedHost;
  live?: LiveCounts;
  onConnect: () => void;
  onMenu: (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) => void;
  dragEnabled: boolean;
  dragging: boolean;
  dropEdge?: 'before' | 'after';
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const title = managedHostDisplayName(host);
  const address = managedHostAddress(host);
  const secondary = host.kind === 'ssh' && address === host.entry.alias ? undefined : address;
  const color = host.entry.metadata?.color;
  const resolved = host.kind === 'ssh' ? host.entry.resolved : undefined;
  const Icon =
    resolved && resolved.proxyJump.length > 0
      ? AltRouteIcon
      : hostKindIcon(host.kind === 'ssh' ? 'ssh' : host.entry.kind);
  const badge = { fontSize: 14, color: 'text.disabled' } as const;

  const row = (
    <ListItemButton
      onMouseEnter={() => void loadTerminalViewImpl()}
      onFocus={() => void loadTerminalViewImpl()}
      onClick={onConnect}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(host, e.currentTarget, { top: e.clientY, left: e.clientX });
      }}
      sx={{
        '&:hover .host-row-menu, &:hover .host-drag-handle, &:focus-within .host-drag-handle': { opacity: 1 },
        opacity: dragging ? 0.45 : 1,
        pr: 0.5,
        borderLeft: 3,
        borderLeftColor: color ?? 'transparent',
        position: 'relative',
        contentVisibility: 'auto',
        containIntrinsicSize: '0 48px',
        ...(dropEdge && {
          [`&::${dropEdge === 'before' ? 'before' : 'after'}`]: {
            content: '""',
            position: 'absolute',
            left: 8,
            right: 8,
            [dropEdge === 'before' ? 'top' : 'bottom']: -1,
            height: 2,
            borderRadius: 2,
            bgcolor: 'primary.main',
            zIndex: 2,
          },
        }),
      }}
    >
      {dragEnabled && (
        <Tooltip title="Drag to reorder or move to a group · Alt+↑/↓">
          <IconButton
            className="host-drag-handle"
            size="small"
            aria-label={`Move ${title}`}
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
              event.preventDefault();
              event.stopPropagation();
              onMove(event.key === 'ArrowUp' ? -1 : 1);
            }}
            sx={{
              opacity: { xs: 0.75, md: 0.2 },
              p: 0.25,
              mr: 0.25,
              cursor: 'grab',
              '&:active': { cursor: 'grabbing' },
              transition: 'opacity 120ms',
            }}
          >
            <DragIndicatorIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
      <ListItemIcon sx={{ minWidth: 32 }}>
        <Icon fontSize="small" sx={{ color: color ?? 'text.secondary' }} />
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
            <TruncationTooltip text={title}>
              <Box
                component="span"
                sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {title}
              </Box>
            </TruncationTooltip>
            {host.entry.metadata?.favorite && <StarIcon sx={{ fontSize: 13, color: 'warning.main' }} />}
            {(live?.connected ?? 0) > 1 && (
              <Typography component="span" sx={{ fontSize: 10, color: 'success.main' }}>
                ×{live!.connected}
              </Typography>
            )}
          </Stack>
        }
        secondary={secondary}
        slotProps={{ secondary: { sx: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } } }}
      />
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0, mr: 0.25 }}>
        {resolved && resolved.proxyJump.length > 0 && (
          <Tooltip title={`via ${resolved.proxyJump.join(' → ')}`}>
            <AltRouteIcon sx={badge} />
          </Tooltip>
        )}
        {resolved && resolved.identityFiles.length > 0 && (
          <Tooltip title={resolved.identityFiles.map((f) => f.split(/[\\/]/).pop()).join(', ')}>
            <KeyOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        {resolved?.passwordOnly && (
          <Tooltip title="Password authentication">
            <PasswordOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        {resolved && resolved.forwards.length > 0 && (
          <Tooltip title={`${resolved.forwards.length} port forward${resolved.forwards.length > 1 ? 's' : ''} on connect`}>
            <SwapHorizOutlinedIcon sx={badge} />
          </Tooltip>
        )}
        <IconButton
          className="host-row-menu"
          size="small"
          edge="end"
          aria-label={`Options for ${title}`}
          sx={{ opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms' }}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(host, e.currentTarget);
          }}
        >
          <Box component="span" sx={{ fontSize: 16, lineHeight: 1 }}>
            ⋮
          </Box>
        </IconButton>
      </Stack>
    </ListItemButton>
  );

  return host.kind === 'ssh' && host.entry.description ? (
    <Tooltip title={host.entry.description} placement="right" enterDelay={600}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}
