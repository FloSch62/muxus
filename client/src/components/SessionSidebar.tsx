import { useDeferredValue, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import TabOutlinedIcon from '@mui/icons-material/TabOutlined';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import type { SshHostEntry } from '@muxus/shared';
import { useReorderManagedHosts } from '../api/host-order.js';
import { useDeleteHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useDeleteHost, useUpdateSshMetadata } from '../api/ssh-config.js';
import { copyToClipboard } from '../clipboard.js';
import { confirmDeleteHost } from '../host-actions.js';
import { hostOrderAfterDrop } from '../host-organization.js';
import {
  groupManagedHosts,
  managedHostAddress,
  managedHostCopyCommand,
  managedHostDisplayName,
  managedHostKey,
  managedHostRef,
  type ManagedHost,
  type ManagedHostGroup,
} from '../managed-hosts.js';
import {
  connectManagedHost,
  connectTarget,
  isQuickConnectTarget,
  launchManagedHostGroup,
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
import type { SessionSetLayout } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { hostKindIcon } from './host-kind-icon.js';
import { PanelResizeHandle } from './PanelResizeHandle.js';

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
  const [launchGroup, setLaunchGroup] = useState<ManagedHostGroup | null>(null);
  const [launchLayout, setLaunchLayout] = useState<SessionSetLayout>('tabs');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragged, setDragged] = useState<{ groupKey: string; hostKey: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const deleteHost = useDeleteHost();
  const deleteProfile = useDeleteHostProfile();
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

  const requestDelete = (host: ManagedHost) => {
    void confirmDeleteHost({
      name: managedHostDisplayName(host),
      sshFile: host.kind === 'ssh' ? host.entry.file : undefined,
    }).then((confirmed) => {
      if (!confirmed) return;
      if (host.kind === 'ssh') deleteHost.mutate(host.entry.alias);
      else deleteProfile.mutate(host.entry.id);
    });
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
        label="Resize hosts sidebar"
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
                  lineHeight: '26px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  px: 0.75,
                  mt: 0.5,
                  borderRadius: 1,
                  transition: 'background-color 120ms ease, color 120ms ease, box-shadow 120ms ease',
                  // Group actions stay out of sight until the header is hovered
                  // or tabbed to; the slot is always laid out so nothing shifts.
                  '&:hover .group-launch, & .group-launch:focus-visible': { opacity: 1 },
                  ...(dropTarget?.kind === 'group' &&
                    dropTarget.groupKey === group.key && {
                      color: 'primary.main',
                      boxShadow: (theme) => `inset 3px 0 ${theme.palette.primary.main}`,
                    }),
                }}
              >
                <Tooltip title={group.tooltip ?? ''} placement="right" disableInteractive>
                  <ButtonBase
                    aria-expanded={!collapsed[group.key]}
                    onClick={() =>
                      setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))
                    }
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      justifyContent: 'flex-start',
                      gap: 0.5,
                      font: 'inherit',
                      letterSpacing: 'inherit',
                      // Form controls drop the inherited transform in some engines.
                      textTransform: 'inherit',
                      color: 'inherit',
                      borderRadius: 1,
                      px: 0.25,
                    }}
                  >
                    <ExpandMoreIcon
                      sx={{
                        fontSize: 14,
                        flexShrink: 0,
                        color: 'text.disabled',
                        transition: 'transform 150ms ease',
                        transform: collapsed[group.key] ? 'rotate(-90deg)' : 'none',
                      }}
                    />
                    <Box
                      component="span"
                      sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {group.label}
                    </Box>
                  </ButtonBase>
                </Tooltip>
                <Tooltip title={group.hosts.length > 0 ? `Launch all ${group.hosts.length} hosts…` : ''}>
                  <span>
                    <IconButton
                      className="group-launch"
                      size="small"
                      aria-label={`Launch ${group.label} group`}
                      disabled={group.hosts.length === 0}
                      onClick={() => {
                        setLaunchGroup(group);
                        setLaunchLayout('tabs');
                      }}
                      sx={{ p: 0.25, opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}
                    >
                      <PlayArrowOutlinedIcon sx={{ fontSize: 15 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Typography
                  component="span"
                  sx={{ fontSize: 11, color: 'text.disabled', minWidth: 14, textAlign: 'right' }}
                >
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
                    showDragGrip={!needle}
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
            if (menu) requestDelete(menu.host);
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

      <Dialog open={!!launchGroup} onClose={() => setLaunchGroup(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Launch “{launchGroup?.label}”</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Start all {launchGroup?.hosts.length ?? 0} hosts and replace the current pane layout.
          </Typography>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={launchLayout}
            onChange={(_event, value: SessionSetLayout | null) => {
              if (value) setLaunchLayout(value);
            }}
            aria-label="Host group layout"
          >
            <ToggleButton value="tabs" aria-label="Tabs">
              <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
                <TabOutlinedIcon fontSize="small" />
                <Typography variant="caption">Tabs</Typography>
              </Stack>
            </ToggleButton>
            <ToggleButton value="columns" aria-label="Columns">
              <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
                <ViewColumnOutlinedIcon fontSize="small" />
                <Typography variant="caption">Columns</Typography>
              </Stack>
            </ToggleButton>
            <ToggleButton value="rows" aria-label="Rows">
              <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
                <TableRowsOutlinedIcon fontSize="small" />
                <Typography variant="caption">Rows</Typography>
              </Stack>
            </ToggleButton>
            <ToggleButton value="grid" aria-label="Grid">
              <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
                <GridViewOutlinedIcon fontSize="small" />
                <Typography variant="caption">Grid</Typography>
              </Stack>
            </ToggleButton>
          </ToggleButtonGroup>
          {tabs.some((tab) => tab.profile && tab.status !== 'closed') ? (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Existing live sessions will be closed when this group replaces the current layout.
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLaunchGroup(null)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<PlayArrowOutlinedIcon />}
            disabled={!launchGroup?.hosts.length}
            onClick={() => {
              if (!launchGroup) return;
              const { hosts: groupHosts, label } = launchGroup;
              void launchManagedHostGroup(groupHosts, launchLayout).then((ids) => {
                if (ids.length === 0) return;
                showToast(
                  'success',
                  `Launching ${ids.length} session${ids.length === 1 ? '' : 's'} from “${label}” in ${launchLayout}.`,
                );
                setLaunchGroup(null);
              });
            }}
          >
            Launch group
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/**
 * What a row deliberately does not draw. Jump chain, key, auth mode and
 * forwards are reference material, not things you act on from the list, so
 * they live in the row's hover card instead of as a row of grey glyphs.
 */
function hostDetailLines(host: ManagedHost): string[] {
  const lines: string[] = [];
  if (host.kind !== 'ssh') return lines;
  if (host.entry.description) lines.push(host.entry.description);
  const resolved = host.entry.resolved;
  if (!resolved) return lines;
  if (resolved.proxyJump.length > 0) lines.push(`via ${resolved.proxyJump.join(' → ')}`);
  if (resolved.identityFiles.length > 0) {
    lines.push(`Key ${resolved.identityFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}`);
  }
  if (resolved.passwordOnly) lines.push('Password authentication');
  if (resolved.forwards.length > 0) {
    lines.push(
      `${resolved.forwards.length} port forward${resolved.forwards.length > 1 ? 's' : ''} on connect`,
    );
  }
  return lines;
}

/** One sidebar row for any host source; details ride along in the hover card. */
function HostRow({
  host,
  live,
  onConnect,
  onMenu,
  showDragGrip,
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
  showDragGrip: boolean;
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
  const Icon = hostKindIcon(host.kind === 'ssh' ? 'ssh' : host.entry.kind);
  const details = hostDetailLines(host);
  const connected = live?.connected ?? 0;
  const connecting = live?.connecting ?? 0;
  const [clipped, setClipped] = useState(false);

  /** The hover card is worth showing only for what the row can't fit. */
  const measure = (event: MouseEvent<HTMLElement>) => {
    const name = event.currentTarget.querySelector('[data-host-name]');
    const line = event.currentTarget.querySelector('.MuiListItemText-secondary');
    setClipped(
      (!!name && name.scrollWidth > name.clientWidth) ||
        (!!line && line.scrollWidth > line.clientWidth),
    );
  };

  const row = (
    <ListItemButton
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={(event) => {
        void loadTerminalViewImpl();
        measure(event);
      }}
      onFocus={() => void loadTerminalViewImpl()}
      onClick={onConnect}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={(event) => {
        if (!dragEnabled || !event.altKey) return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        onMove(event.key === 'ArrowUp' ? -1 : 1);
      }}
      aria-keyshortcuts={dragEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(host, e.currentTarget, { top: e.clientY, left: e.clientX });
      }}
      sx={{
        '&:hover .host-row-menu, & .host-row-menu:focus-visible': { opacity: 1 },
        // The grip takes over the kind-icon slot on hover: the reorder
        // affordance costs no width and no row is decorated at rest.
        ...(showDragGrip && {
          '&:hover .host-drag-grip': { opacity: 0.55 },
          '&:hover .host-kind-icon': { opacity: 0 },
        }),
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
      <ListItemIcon sx={{ minWidth: 32 }}>
        <Box sx={{ position: 'relative', display: 'flex', cursor: dragEnabled ? 'grab' : undefined }}>
          <Icon
            className="host-kind-icon"
            fontSize="small"
            sx={{ color: color ?? 'text.secondary', transition: 'opacity 120ms ease' }}
          />
          {showDragGrip && (
            <DragIndicatorIcon
              className="host-drag-grip"
              sx={{
                position: 'absolute',
                inset: 0,
                fontSize: 20,
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 120ms ease',
              }}
            />
          )}
          {connected + connecting > 0 && (
            <Box
              sx={{
                position: 'absolute',
                right: -3,
                bottom: -2,
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: connected > 0 ? 'success.main' : 'warning.main',
                boxShadow: (theme) => `0 0 0 2px ${theme.palette.sidebar}`,
                ...(connected === 0 && {
                  animation: 'muxus-pulse 1.2s ease-in-out infinite',
                  '@keyframes muxus-pulse': { '50%': { opacity: 0.3 } },
                }),
              }}
            />
          )}
        </Box>
      </ListItemIcon>
      <ListItemText
        primary={
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Box
              component="span"
              data-host-name
              sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {title}
            </Box>
            {host.entry.metadata?.favorite && (
              <StarIcon sx={{ fontSize: 13, flexShrink: 0, color: 'warning.main' }} />
            )}
            {connected > 1 && (
              <Typography component="span" sx={{ fontSize: 10, flexShrink: 0, color: 'success.main' }}>
                ×{connected}
              </Typography>
            )}
          </Stack>
        }
        secondary={secondary}
        slotProps={{ secondary: { sx: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } } }}
      />
      <IconButton
        className="host-row-menu"
        size="small"
        edge="end"
        aria-label={`Options for ${title}`}
        sx={{ flexShrink: 0, ml: 0.25, opacity: { xs: 1, md: 0 }, transition: 'opacity 120ms ease' }}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(host, e.currentTarget);
        }}
      >
        <MoreVertIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </ListItemButton>
  );

  return (
    <Tooltip
      placement="right"
      enterDelay={500}
      enterNextDelay={250}
      disableInteractive
      title={
        details.length === 0 && !clipped ? (
          ''
        ) : (
          <Stack spacing={0.25} sx={{ py: 0.25 }}>
            <Box sx={{ fontWeight: 600 }}>{title}</Box>
            {address !== title && <Box sx={{ opacity: 0.7 }}>{address}</Box>}
            {details.length > 0 && (
              <Stack spacing={0.25} sx={{ pt: 0.5, opacity: 0.7 }}>
                {details.map((line) => (
                  <Box key={line}>{line}</Box>
                ))}
              </Stack>
            )}
          </Stack>
        )
      }
    >
      {row}
    </Tooltip>
  );
}
