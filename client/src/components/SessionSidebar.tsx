import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SearchIcon from '@mui/icons-material/Search';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import { useApplyFolderMoves } from '../api/host-groups.js';
import { useReorderManagedHosts } from '../api/host-order.js';
import { useDeleteHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { useDeleteHost, useUpdateSshMetadata } from '../api/ssh-config.js';
import { confirmDeleteHost } from '../host-actions.js';
import { hostOrderAfterDrop } from '../host-organization.js';
import {
  buildHostTree,
  folderParentPath,
  folderSiblings,
  siblingHostKeys,
  type ContainerNode,
  type FolderNode,
  type VisibleNode,
} from '../host-tree.js';
import {
  bestManagedHostMatch,
  groupManagedHosts,
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
} from '../session-actions.js';
import {
  loadFolderDialog,
  loadHostEditorDialog,
  loadSidebarMenus,
  loadTerminalViewImpl,
} from '../lazy-features.js';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from '../sidebar-width.js';
import { confirmAction } from '../state/dialogs.js';
import { usePrefsStore } from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';
import { PanelResizeHandle } from './PanelResizeHandle.js';
import { deleteFolderPlan, folderRewritePlan } from './sidebar/folder-mutations.js';
import type { FolderMenuState } from './sidebar/FolderContextMenu.js';
import type { HostMenuState } from './sidebar/HostContextMenu.js';
import { HostTree } from './sidebar/HostTree.js';
import type { LaunchTarget } from './sidebar/LaunchGroupDialog.js';
import { useAllManagedHosts } from './sidebar/useAllManagedHosts.js';
import { useFolderPrefs } from './sidebar/useFolderPrefs.js';
import { useLiveHostCounts } from './sidebar/useLiveHostCounts.js';
import { useTreeDnd, type FolderPlacement } from './sidebar/useTreeDnd.js';

const SidebarMenus = lazy(() =>
  loadSidebarMenus().then((module) => ({ default: module.SidebarMenus })),
);

const EMPTY_HOSTS: SshHostEntry[] = [];
const EMPTY_PROFILES: SavedHostProfile[] = [];
const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Saved Telnet/serial profiles and live OpenSSH hosts in one host manager. */
export function SessionSidebar() {
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setFolderDialog = useUiStore((s) => s.setFolderDialog);
  const sidebarWidth = usePrefsStore((state) => state.sidebarWidth);
  const setPrefs = usePrefsStore((state) => state.set);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<HostMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [launchTarget, setLaunchTarget] = useState<LaunchTarget | null>(null);
  /** Folders collapsed during a search; discarded when the query changes. */
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const deleteHost = useDeleteHost();
  const deleteProfile = useDeleteHostProfile();
  const updateMetadata = useUpdateSshMetadata();
  const updateProfileMetadata = useUpdateHostProfileMetadata();
  const reorder = useReorderManagedHosts();
  const applyFolderMoves = useApplyFolderMoves();
  const liveByKey = useLiveHostCounts();
  const folders = useFolderPrefs();
  const allHosts = useAllManagedHosts();

  const normalizedFilter = filter.trim().toLowerCase();
  const needle = useDeferredValue(normalizedFilter);
  const hosts = config?.hosts ?? EMPTY_HOSTS;
  const profiles = savedData?.profiles ?? EMPTY_PROFILES;

  const groups = useMemo(
    () => groupManagedHosts(hosts, profiles, config?.files ?? [], config?.path, needle),
    [hosts, profiles, config?.files, config?.path, needle],
  );
  const tree = useMemo(
    () =>
      buildHostTree(groups, {
        knownFolders: folders.emptyFolders,
        folderOrder: folders.folderOrder,
      }),
    [groups, folders.emptyFolders, folders.folderOrder],
  );
  // The list itself lags behind typing, but quick-connect must answer for the
  // text as typed, so the winner is scored against the flat host list instead.
  const bestMatch = useMemo(
    () => bestManagedHostMatch(allHosts, normalizedFilter),
    [allHosts, normalizedFilter],
  );
  // Highlight it in the tree, once the tree has caught up with the query.
  const matchKey = bestMatch ? managedHostKey(bestMatch) : undefined;
  const hostByKey = useMemo(
    () => new Map(tree.hosts.map((host) => [managedHostKey(host), host])),
    [tree],
  );

  const mutating =
    reorder.isPending ||
    updateMetadata.isPending ||
    updateProfileMetadata.isPending ||
    applyFolderMoves.isPending;
  const filtering = !!needle;
  const reorderEnabled = !filtering && !mutating;
  useEffect(() => {
    setSearchCollapsed(EMPTY_KEYS);
  }, [needle]);
  // Folder edits rewrite paths across hosts the filter may be hiding, so they
  // are only offered against the full list.
  const folderEditsEnabled = !filtering && !mutating;

  const commitOrder = useCallback(
    (keys: readonly string[]) =>
      reorder.mutate(
        keys.flatMap((key) => {
          const host = hostByKey.get(key);
          return host ? [managedHostRef(host)] : [];
        }),
      ),
    [reorder, hostByKey],
  );

  /** Reorder a host among its siblings — folders are always alphabetical. */
  const moveHostByKey = useCallback(
    (key: string, delta: -1 | 1) => {
      if (!reorderEnabled) return;
      for (const container of allContainers(tree.roots)) {
        const keys = siblingHostKeys(container);
        const from = keys.indexOf(key);
        if (from < 0) continue;
        const to = from + delta;
        if (to < 0 || to >= keys.length) return;
        [keys[from], keys[to]] = [keys[to]!, keys[from]!];
        commitOrder(keys);
        return;
      }
    },
    [tree, commitOrder, reorderEnabled],
  );
  const moveHost = useCallback(
    (row: VisibleNode, delta: -1 | 1) => moveHostByKey(row.key, delta),
    [moveHostByKey],
  );

  /** Commit a drag: change the host's folder if it moved, then its order. */
  const dropHost = useCallback(
    (hostKey: string, path: string | undefined, order: string[]) => {
      const host = hostByKey.get(hostKey);
      if (!host) return;
      if (path === undefined) {
        commitOrder(order);
        return;
      }
      const patch = { group: path || null };
      const moved =
        host.kind === 'ssh'
          ? updateMetadata.mutateAsync({ alias: host.entry.alias, patch })
          : updateProfileMetadata.mutateAsync({ id: host.entry.id, patch });
      // Order is only meaningful once the host actually belongs to the folder.
      void moved.then(() => commitOrder(order)).catch(() => undefined);
    },
    [hostByKey, commitOrder, updateMetadata, updateProfileMetadata],
  );

  const dropFolder = useCallback(
    (fromPath: string, toPath: string, placement?: FolderPlacement) => {
      // The key changes with the path, so carry colour, collapse state and the
      // sibling order across before anything is written.
      if (fromPath !== toPath) {
        folders.renameFolderPrefs(fromPath, toPath);
        const moves = folderRewritePlan(allHosts, fromPath, toPath);
        if (moves.length > 0) applyFolderMoves.mutate({ moves, label: toPath });
        else folders.addEmptyFolder(toPath);
        folders.removeEmptyFolder(fromPath);
      }
      if (placement) folders.setFolderOrder(placement.parentKey, placement.keys);
    },
    [allHosts, folders, applyFolderMoves],
  );

  /** Alt+Arrow on a folder: swap it with the sibling folder next to it. */
  const moveFolderByKey = useCallback(
    (key: string, delta: -1 | 1) => {
      if (!reorderEnabled) return;
      const siblings = folderSiblings(tree, key);
      if (!siblings) return;
      const keys = [...siblings.keys];
      const from = keys.indexOf(key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= keys.length) return;
      [keys[from], keys[to]] = [keys[to]!, keys[from]!];
      folders.setFolderOrder(siblings.parentKey, keys);
    },
    [tree, folders, reorderEnabled],
  );
  const moveFolder = useCallback(
    (row: VisibleNode, delta: -1 | 1) => moveFolderByKey(row.key, delta),
    [moveFolderByKey],
  );

  const dnd = useTreeDnd({
    tree,
    enabled: reorderEnabled,
    onDropHost: dropHost,
    onDropFolder: dropFolder,
    hostOrderAfterDrop,
  });

  const folderColor = useCallback(
    (key: string) => folders.folderStyle(key)?.color,
    [folders],
  );
  const folderIconId = useCallback(
    (key: string) => folders.folderStyle(key)?.icon,
    [folders],
  );

  const quickConnectable = !!normalizedFilter && !bestMatch && isQuickConnectTarget(filter);

  const onEnter = () => {
    if (bestMatch) connectManagedHost(bestMatch);
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

  const openMenu = useCallback(
    (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) =>
      setMenu({ anchor, position, host }),
    [],
  );

  const launchNode = useCallback(
    (node: ContainerNode) =>
      setLaunchTarget({ label: node.label, hosts: collectHosts(node) }),
    [],
  );

  const openFolderMenu = useCallback(
    (node: ContainerNode, anchor: HTMLElement, position?: { top: number; left: number }) => {
      // ssh_config file groups are defined by the config file, not by Muxus.
      if (node.kind !== 'folder') return;
      setFolderMenu({ anchor, position, node });
    },
    [],
  );

  /**
   * Expansion has two layers. Normally it is the persisted one. While a filter
   * is active every folder opens — `groupManagedHosts` has already dropped the
   * non-matching hosts, so "expand what contains a hit" is just "expand all" —
   * and collapses made during the search live in a scratch set. The persisted
   * layer is never written to while filtering, so clearing the box restores
   * exactly the shape the sidebar had before.
   */
  const isExpanded = useCallback(
    (key: string) => (filtering ? !searchCollapsed.has(key) : folders.isExpanded(key)),
    [filtering, searchCollapsed, folders],
  );
  const setCollapsedKeys = useCallback(
    (keys: readonly string[], collapsed: boolean) => {
      if (filtering) {
        setSearchCollapsed((current) => {
          const next = new Set(current);
          for (const key of keys) {
            if (collapsed) next.add(key);
            else next.delete(key);
          }
          return next;
        });
        return;
      }
      const next = new Set(usePrefsStore.getState().sidebarCollapsedFolders);
      for (const key of keys) {
        if (collapsed) next.add(key);
        else next.delete(key);
      }
      setPrefs({ sidebarCollapsedFolders: [...next] });
    },
    [filtering, setPrefs],
  );
  const setExpanded = useCallback(
    (key: string, expanded: boolean) => setCollapsedKeys([key], !expanded),
    [setCollapsedKeys],
  );

  /** Collapse a folder and everything nested inside it, in one write. */
  const collapseSubtree = useCallback(
    (node: FolderNode) => {
      const keys = [node.key];
      const walk = (folder: FolderNode) => {
        for (const child of folder.children) {
          if (child.kind !== 'folder') continue;
          keys.push(child.key);
          walk(child);
        }
      };
      walk(node);
      setCollapsedKeys(keys, true);
    },
    [setCollapsedKeys],
  );

  const deleteFolder = useCallback(
    (node: FolderNode) => {
      const moves = deleteFolderPlan(allHosts, node.path);
      const parent = folderParentPath(node.path);
      void confirmAction({
        title: `Delete “${node.label}”?`,
        description:
          moves.length === 0
            ? 'The folder is empty, so nothing else changes.'
            : `${moves.length} host${moves.length === 1 ? '' : 's'} move${moves.length === 1 ? 's' : ''} ${parent ? `up into “${parent}”` : 'out of every folder'}. No connection settings change.`,
        confirmLabel: 'Delete folder',
        destructive: true,
      }).then((confirmed) => {
        if (!confirmed) return;
        folders.removeEmptyFolder(node.path);
        folders.setFolderStyle(node.key, undefined);
        if (moves.length > 0) applyFolderMoves.mutate({ moves, label: node.label });
      });
    },
    [allHosts, folders, applyFolderMoves],
  );

  // Where the menu's host sits among its siblings, for Move up / Move down.
  const menuPosition = useMemo(() => {
    if (!menu) return { index: -1, total: 0 };
    const key = managedHostKey(menu.host);
    for (const container of allContainers(tree.roots)) {
      const keys = siblingHostKeys(container);
      const index = keys.indexOf(key);
      if (index >= 0) return { index, total: keys.length };
    }
    return { index: -1, total: 0 };
  }, [menu, tree]);

  /** Where the menu's folder sits among its siblings, for Move up / Move down. */
  const folderMenuPosition = useMemo(() => {
    const siblings = folderMenu ? folderSiblings(tree, folderMenu.node.key) : undefined;
    return siblings
      ? { index: siblings.keys.indexOf(folderMenu!.node.key), total: siblings.keys.length }
      : { index: -1, total: 0 };
  }, [folderMenu, tree]);

  const empty = hosts.length === 0 && profiles.length === 0;

  return (
    <Box
      ref={sidebarRef}
      // Every menu and the launch dialog live in one lazy chunk. Pointing at
      // the sidebar at all is enough warning to have it ready by the time a
      // right-click lands.
      onMouseEnter={() => void loadSidebarMenus()}
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
          inputRef={searchRef}
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
            if (e.key === 'ArrowDown') {
              // Hand off to the tree rather than moving the text cursor.
              e.preventDefault();
              sidebarRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
            }
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
        <Tooltip title="New folder">
          <span>
            <IconButton
              size="small"
              aria-label="New folder"
              disabled={!folderEditsEnabled}
              onMouseEnter={() => void loadFolderDialog()}
              onFocus={() => void loadFolderDialog()}
              onClick={() => setFolderDialog({ mode: 'new' })}
            >
              <CreateNewFolderOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
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
            <ListItemIcon sx={{ minWidth: 28 }}>
              <TerminalIcon sx={{ fontSize: 16 }} />
            </ListItemIcon>
            <ListItemText primary="Local terminal" slotProps={{ primary: { sx: { fontSize: 13 } } }} />
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
              <ListItemIcon sx={{ minWidth: 28 }}>
                <BoltIcon sx={{ fontSize: 16 }} color="primary" />
              </ListItemIcon>
              <ListItemText
                primary={`Connect to ${filter.trim()}`}
                slotProps={{ primary: { sx: { fontSize: 13, color: 'primary.main' } } }}
              />
            </ListItemButton>
          )}
        </List>

        {config?.error && (
          <Alert severity="warning" sx={{ mx: 1, my: 0.5, py: 0, fontSize: 12 }}>
            {config.error}
          </Alert>
        )}

        <HostTree
          tree={tree}
          matchKey={matchKey}
          isExpanded={isExpanded}
          setExpanded={setExpanded}
          folderColor={folderColor}
          folderIconId={folderIconId}
          liveByKey={liveByKey}
          reorderEnabled={reorderEnabled}
          onConnect={connectManagedHost}
          onHostMenu={openMenu}
          onFolderMenu={openFolderMenu}
          onLaunch={launchNode}
          onMoveHost={moveHost}
          onMoveFolder={moveFolder}
          onEscape={() => searchRef.current?.focus()}
          dnd={dnd.binding}
        />

        {empty && (
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
        {!empty && tree.hosts.length === 0 ? (
          // Nothing matched is the moment you are most likely to want the host
          // you just typed, so offer to save it rather than only saying no.
          <Stack spacing={1.5} sx={{ alignItems: 'center', p: 2, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No hosts match.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              sx={{ maxWidth: '100%' }}
              onMouseEnter={() => void loadHostEditorDialog()}
              onFocus={() => void loadHostEditorDialog()}
              onClick={() => setHostEditor({ mode: 'new', prefillTarget: filter.trim() })}
            >
              Add “{filter.trim()}”
            </Button>
          </Stack>
        ) : null}
      </Box>

      {(menu || folderMenu || launchTarget) && (
        <Suspense fallback={null}>
          <SidebarMenus
            host={{
              menu,
              onClose: () => setMenu(null),
              canMoveUp: reorderEnabled && menuPosition.index > 0,
              canMoveDown:
                reorderEnabled &&
                menuPosition.index >= 0 &&
                menuPosition.index < menuPosition.total - 1,
              onMove: (delta) => {
                if (menu) moveHostByKey(managedHostKey(menu.host), delta);
              },
              onToggleFavorite: toggleFavorite,
              onDelete: requestDelete,
              onMoveToFolder: (host) =>
                setFolderDialog({
                  mode: 'move-host',
                  hostKey: managedHostKey(host),
                  hostName: managedHostDisplayName(host),
                  currentPath: host.entry.metadata?.group ?? '',
                }),
            }}
            folder={{
              menu: folderMenu,
              onClose: () => setFolderMenu(null),
              onNewChild: (node) => setFolderDialog({ mode: 'new', parentPath: node.path }),
              onEdit: (node) => setFolderDialog({ mode: 'edit', path: node.path }),
              onLaunch: launchNode,
              onCollapseAll: collapseSubtree,
              onDelete: deleteFolder,
              onMove: (node, delta) => moveFolderByKey(node.key, delta),
              canMoveUp: reorderEnabled && folderMenuPosition.index > 0,
              canMoveDown:
                reorderEnabled &&
                folderMenuPosition.index >= 0 &&
                folderMenuPosition.index < folderMenuPosition.total - 1,
            }}
            launch={{ target: launchTarget, onClose: () => setLaunchTarget(null) }}
          />
        </Suspense>
      )}
    </Box>
  );
}

/** Depth-first walk of every container, so sibling lookups can scan once. */
function* allContainers(nodes: readonly ContainerNode[]): Generator<ContainerNode> {
  for (const node of nodes) {
    yield node;
    if (node.kind === 'folder') {
      yield* allContainers(node.children.filter((child) => child.kind === 'folder'));
    }
  }
}

function collectHosts(node: ContainerNode): ManagedHost[] {
  const out: ManagedHost[] = [];
  const walk = (container: ContainerNode) => {
    for (const child of container.children) {
      if (child.kind === 'host') out.push(child.host);
      else if (child.kind === 'folder') walk(child);
    }
  };
  walk(node);
  return out;
}

