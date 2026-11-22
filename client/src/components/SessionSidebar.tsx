import {
  lazy,
  memo,
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
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SearchIcon from '@mui/icons-material/Search';
import TerminalIcon from '@mui/icons-material/Terminal';
import { useQueryClient } from '@tanstack/react-query';
import type { SavedHostProfile, SshHostEntry } from '@muxus/shared';
import {
  hasFolderSettingsUnder,
  useDeleteFolderSettings,
  useFolderSettings,
  useMoveFolderSettings,
} from '../api/folder-settings.js';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import {
  confirmRemoveSharedSessions,
  refreshSharedSessionsNow,
  sharedSessionsOrigin,
  sharedSessionsState,
  useDeleteSharedSessionSource,
  useSharedSessionSources,
  useSharedSessionsBeingRead,
} from '../api/shared-sessions.js';
import { tabHostKey } from '../host-sessions.js';
import { hostOrderAfterDrop } from '../host-organization.js';
import {
  buildHostTree,
  folderKey,
  folderParentPath,
  folderSegments,
  folderSiblings,
  siblingHostKeys,
  type ContainerNode,
  type FolderNode,
  type VisibleNode,
} from '../host-tree.js';
import {
  alphabetizeManagedHosts,
  bestManagedHostMatch,
  groupManagedHosts,
  managedHostKey,
  type ManagedHost,
} from '../managed-hosts.js';
import {
  buildHostListTree,
  buildHostScopeTree,
  isSectionKey,
} from '../host-views.js';
import { hostFolderLabel } from '../hosts-table.js';
import { useWslShellProfiles } from '../local-shell-launchers.js';
import {
  connectManagedHost,
  connectTarget,
  isQuickConnectTarget,
  openLocalShellProfile,
  openLocalTerminal,
} from '../session-actions.js';
import {
  loadHostEditorDialog,
  loadSidebarMenus,
  loadTerminalViewImpl,
} from '../lazy-features.js';
import { confirmAction } from '../state/dialogs.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { openScriptsFor } from '../scripts/script-jobs.js';
import { useUiStore } from '../state/ui.js';
import { clickOpensRow, type HostActivation } from './sidebar/row-clicks.js';
import { treeLabelSx, treeRowSx } from './sidebar/tree-row-style.js';
import { deleteFolderPlan, folderRewritePlan } from './sidebar/folder-mutations.js';
import type { FolderMenuState } from './sidebar/FolderContextMenu.js';
import type { HostMenuState } from './sidebar/HostContextMenu.js';
import type { HostSessionsMenuState } from './sidebar/HostSessionsMenu.js';
import type { LocalShellMenuState } from './sidebar/LocalShellContextMenu.js';
import { LocalShellIcon } from './LocalShellIcon.js';
import { EnvironmentBadges } from './environments/EnvironmentBadges.js';
import { LOCAL_ENVIRONMENT_KEY } from '../state/environments.js';
import { HostTree, type HostTreeHandle } from './sidebar/HostTree.js';
import { HostViewBar } from './sidebar/HostViewBar.js';
import { SelectionBar } from './sidebar/SelectionBar.js';
import type { LaunchTarget } from './sidebar/LaunchGroupDialog.js';
import { useAllManagedHosts } from './sidebar/useAllManagedHosts.js';
import { useFolderPrefs } from './sidebar/useFolderPrefs.js';
import { useLiveHostCounts } from './sidebar/useLiveHostCounts.js';
import { useHostActions } from './sidebar/useHostActions.js';
import { useTreeDnd, type FolderPlacement } from './sidebar/useTreeDnd.js';
import { layout } from '../theme.js';

const SidebarMenus = lazy(() =>
  loadSidebarMenus().then((module) => ({ default: module.SidebarMenus })),
);

const EMPTY_HOSTS: SshHostEntry[] = [];
const EMPTY_PROFILES: SavedHostProfile[] = [];
const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** The fixed rows above the tree share the tree rows' exact geometry. */
const fixedRowSx = [treeRowSx(0, undefined), { gap: 0.75 }] as const;

/**
 * Saved Telnet/serial/RDP/VNC profiles and live OpenSSH hosts in one host manager.
 *
 * Memoized: it takes no props, and the app shell re-renders on every tab
 * update — each session steps through several states while it connects, and a
 * restored workspace connects many at once. The sidebar only follows the
 * stores it reads itself.
 */
export const SessionSidebar = memo(function SessionSidebar() {
  const { data: config, isSuccess: sshConfigReady } = useSshConfig();
  const { data: savedData, isSuccess: savedProfilesReady } = useSavedHostProfiles();
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setFolderDialog = useUiStore((s) => s.setFolderDialog);
  const setSharedSessionsDialog = useUiStore((s) => s.setSharedSessionsDialog);
  const sidebarPosition = usePrefsStore((state) => state.sidebarPosition);
  const openGesture = usePrefsStore((state) => state.sidebarOpenGesture);
  const hostView = usePrefsStore((state) => state.sidebarHostView);
  const hostGrouping = usePrefsStore((state) => state.sidebarHostGrouping);
  const scopePath = useUiStore((state) => state.sidebarScopePath);
  const setScopePath = useUiStore((state) => state.setSidebarScopePath);
  const localShellProfiles = usePrefsStore((state) => state.localShellProfiles);
  const wslShellProfiles = useWslShellProfiles();
  const setPrefs = usePrefsStore((state) => state.set);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HostTreeHandle>(null);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<HostMenuState | null>(null);
  const [sessionsMenu, setSessionsMenu] = useState<HostSessionsMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [panelMenu, setPanelMenu] = useState<{ top: number; left: number } | null>(null);
  const [addMenu, setAddMenu] = useState<HTMLElement | null>(null);
  const [shellMenu, setShellMenu] = useState<LocalShellMenuState | null>(null);
  const [launchTarget, setLaunchTarget] = useState<LaunchTarget | null>(null);
  /** Folders collapsed during a search; discarded when the query changes. */
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  /** Sections of the flat list folded away; they start open. */
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  /** "Today" has to roll over in a window that stays open for days. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  /** Hosts picked for a bulk action. Kept while searching, so a selection can span queries. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const { data: folderSettingsData } = useFolderSettings();
  const moveFolderSettings = useMoveFolderSettings();
  const deleteFolderSettings = useDeleteFolderSettings();
  const liveByKey = useLiveHostCounts();
  const folders = useFolderPrefs();
  const allHosts = useAllManagedHosts();

  const normalizedFilter = filter.trim().toLowerCase();
  const needle = useDeferredValue(normalizedFilter);
  const hosts = config?.hosts ?? EMPTY_HOSTS;
  const profiles = savedData?.profiles ?? EMPTY_PROFILES;
  // Installed WSL distributions follow the saved profiles, launched the same way.
  const visibleLocalShellProfiles = useMemo(
    () =>
      [...localShellProfiles, ...wslShellProfiles].filter((profile) => {
        if (!needle) return true;
        return [profile.name, profile.shell, ...profile.args, profile.cwd]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle);
      }),
    [localShellProfiles, wslShellProfiles, needle],
  );

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
  // The other two layouts are views over the same tree. A search looks
  // everywhere, so it steps out of the folder the list is narrowed to.
  const scope = useMemo(
    () => buildHostScopeTree(tree, needle ? '' : scopePath),
    [tree, needle, scopePath],
  );
  const liveKeys = useMemo(() => new Set(liveByKey.keys()), [liveByKey]);
  const shownTree = useMemo(
    () =>
      hostView === 'list'
        ? buildHostListTree(tree, { grouping: hostGrouping, liveKeys, now })
        : hostView === 'scope'
          ? scope.tree
          : tree,
    [hostView, tree, hostGrouping, liveKeys, now, scope],
  );
  const scopeDepth = folderSegments(scope.path).length;
  const hostDetail = useMemo(
    () =>
      hostView === 'tree'
        ? undefined
        : (host: ManagedHost) =>
            hostFolderLabel(host, hostView === 'scope' ? scopeDepth : 0) || undefined,
    [hostView, scopeDepth],
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
  // Resolved against every host rather than the filtered tree: a host the
  // search hides is still selected, while a deleted one simply drops out.
  const selectedHosts = useMemo(() => {
    if (selection.size === 0) return [];
    const byKey = new Map(allHosts.map((host) => [managedHostKey(host), host]));
    return [...selection].flatMap((key) => {
      const host = byKey.get(key);
      return host ? [host] : [];
    });
  }, [allHosts, selection]);
  const clearSelection = useCallback(() => setSelection(EMPTY_KEYS), []);

  const {
    editHosts,
    requestDelete,
    requestDeleteHosts,
    moveHosts,
    commitOrder,
    dropHosts,
    applyFolderMoves,
    mutating,
  } = useHostActions(hostByKey, clearSelection);

  const filtering = !!needle;
  // Both catalogs must be complete before an order can be persisted: writing
  // a partial list would leave the omitted source carrying conflicting ranks.
  const hostCatalogsReady = sshConfigReady && savedProfilesReady;
  const reorderEnabled = hostCatalogsReady && !filtering && !mutating;
  useEffect(() => {
    setSearchCollapsed(EMPTY_KEYS);
  }, [needle]);
  // Folder edits rewrite paths across hosts the filter may be hiding, so they
  // are only offered against the full list.
  const folderEditsEnabled = hostCatalogsReady && !filtering && !mutating;

  const alphabetizeHosts = useCallback(
    (items: readonly ManagedHost[]) => {
      if (!reorderEnabled || items.length < 2) return;
      commitOrder(alphabetizeManagedHosts(items).map(managedHostKey));
    },
    [commitOrder, reorderEnabled],
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
        // The endpoint is idempotent. Always call it so credentials cannot be
        // stranded when the folder-settings query is loading or has failed.
        moveFolderSettings.mutate({ from: fromPath, to: toPath });
      }
      if (placement) folders.setFolderOrder(placement.parentKey, placement.keys);
    },
    [allHosts, folders, applyFolderMoves, moveFolderSettings],
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

  // A folder in scope that is gone — deleted, renamed, emptied — leaves the
  // list at the top; say so, or the bar would name a folder that no longer is.
  useEffect(() => {
    if (!hostCatalogsReady || filtering || hostView !== 'scope') return;
    if (scope.path !== scopePath) setScopePath(scope.path);
  }, [hostCatalogsReady, filtering, hostView, scope.path, scopePath, setScopePath]);

  const dnd = useTreeDnd({
    tree,
    enabled: reorderEnabled,
    // Only the tree shows the hosts in their own order, so only there can a
    // drop say where among them a host should go.
    targets: hostView === 'tree' ? 'all' : hostView === 'scope' ? 'folders' : 'none',
    selection,
    onDropHosts: dropHosts,
    onDropFolder: dropFolder,
    hostOrderAfterDrop,
  });

  // Shared sessions links, by the folder each keeps its hosts in.
  const queryClient = useQueryClient();
  const { data: sharedSessions } = useSharedSessionSources();
  const sharedSessionsBeingRead = useSharedSessionsBeingRead();
  const stopFollowing = useDeleteSharedSessionSource();
  const linkByFolderKey = useMemo(
    () => new Map((sharedSessions?.sources ?? []).map((source) => [folderKey(source.folder), source])),
    [sharedSessions],
  );
  const folderLink = useCallback(
    (key: string) => {
      const source = linkByFolderKey.get(key);
      if (!source) return undefined;
      const state = sharedSessionsState(source);
      const failing = state.tone === 'error';
      return {
        tooltip: failing
          ? `Shared sessions not updated: ${state.text}`
          : `Shared sessions from ${sharedSessionsOrigin(source.url)} · ${state.text}`,
        failing,
      };
    },
    [linkByFolderKey],
  );
  const folderMenuLink = folderMenu ? linkByFolderKey.get(folderMenu.node.key) : undefined;

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

  const openMenu = useCallback(
    (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) =>
      setMenu({ anchor, position, host }),
    [],
  );

  /**
   * A host that already has tabs in this window lists them first, so a click
   * lands on the session you had instead of stacking up duplicates. A
   * middle-click, and any host with nothing open, connect straight away.
   */
  const activateHost = useCallback(
    (host: ManagedHost, anchor: HTMLElement | undefined, gesture: HostActivation) => {
      const key = managedHostKey(host);
      const hasSessions = useTabsStore.getState().tabs.some((tab) => tabHostKey(tab) === key);
      // The second click of a double-click on a host that had nothing open
      // finds the tab the first click just made; connecting again lets the
      // launch guard swallow it rather than answering with a menu.
      if (!anchor || !hasSessions || gesture.newSession || gesture.repeat) {
        connectManagedHost(host);
        return;
      }
      setSessionsMenu({ anchor, host, openedAt: performance.now() });
    },
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

  // Sections of the flat list fold in place and are never persisted. The
  // folders of the scope view do not unfold at all: opening one steps into it.
  const isExpandedShown = useCallback(
    (key: string) => {
      if (hostView === 'tree') return isExpanded(key);
      return isSectionKey(key) ? !collapsedSections.has(key) : false;
    },
    [hostView, isExpanded, collapsedSections],
  );
  const setExpandedShown = useCallback(
    (key: string, expanded: boolean) => {
      if (hostView === 'tree') {
        setExpanded(key, expanded);
        return;
      }
      if (isSectionKey(key)) {
        setCollapsedSections((current) => {
          const next = new Set(current);
          if (expanded) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      const folder = tree.foldersByKey.get(key);
      if (folder) setScopePath(folder.path);
    },
    [hostView, setExpanded, tree, setScopePath],
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
      const hasCredentials = folderSettingsData
        ? hasFolderSettingsUnder(folderSettingsData.folders, node.path)
        : undefined;
      const hostsText =
        moves.length === 0
          ? 'The folder is empty.'
          : `${moves.length} host${moves.length === 1 ? '' : 's'} move${moves.length === 1 ? 's' : ''} ${parent ? `up into “${parent}”` : 'out of every folder'}.`;
      void confirmAction({
        title: `Delete “${node.label}”?`,
        description: hasCredentials === true
          ? `${hostsText} Its shared SSH credentials are removed.`
          : hasCredentials === undefined
            ? `${hostsText} Any shared SSH credentials on it are removed.`
            : moves.length === 0
              ? 'The folder is empty, so nothing else changes.'
              : `${hostsText} No connection settings change.`,
        confirmLabel: 'Delete folder',
        destructive: true,
      }).then((confirmed) => {
        if (!confirmed) return;
        folders.removeEmptyFolder(node.path);
        folders.setFolderStyle(node.key, undefined);
        if (moves.length > 0) applyFolderMoves.mutate({ moves, label: node.label });
        // Like move, delete is idempotent and must not depend on cached query
        // data that may not have arrived yet.
        deleteFolderSettings.mutate(node.path);
      });
    },
    [allHosts, folders, applyFolderMoves, folderSettingsData, deleteFolderSettings],
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
  const folderMenuHostCount = folderMenu
    ? siblingHostKeys(folderMenu.node).length
    : 0;

  const empty = hosts.length === 0 && profiles.length === 0;
  // Hover cards open toward the panes, wherever the sidebar docks.
  const onRight = sidebarPosition === 'right';
  const hoverPlacement = onRight ? 'left' : 'right';

  return (
    <Box
      // Every menu and the launch dialog live in one lazy chunk. Pointing at
      // the sidebar at all is enough warning to have it ready by the time a
      // right-click lands.
      onMouseEnter={() => void loadSidebarMenus()}
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* As tall as the other panels' title rows and the tab strip beside
          them, so search, titles and tabs share one line. */}
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          height: layout.tabStripHeight,
          flexShrink: 0,
          boxSizing: 'border-box',
          pl: 1.25,
          pr: 0.75,
          alignItems: 'center',
        }}
      >
        <TextField
          fullWidth
          inputRef={searchRef}
          placeholder="Search or user@host ⏎"
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
              treeRef.current?.focusFirst();
            }
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 17 }} />
                </InputAdornment>
              ),
              sx: { fontSize: 13, pl: 1.25 },
            },
          }}
        />
        {/* Adding a folder lives in the panel's right-click menu: one action in
            the header leaves the search box the width it needs to say that it
            also connects. */}
        <Tooltip title={addMenu ? '' : 'Add a host, folder or shared sessions link'}>
          <IconButton
            size="small"
            aria-label="Add"
            aria-haspopup="menu"
            aria-expanded={addMenu ? true : undefined}
            onMouseEnter={() => void loadHostEditorDialog()}
            onFocus={() => void loadHostEditorDialog()}
            onClick={(event) => setAddMenu(event.currentTarget)}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <HostViewBar
        view={hostView}
        onViewChange={(sidebarHostView) => setPrefs({ sidebarHostView })}
        grouping={hostGrouping}
        onGroupingChange={(sidebarHostGrouping) => setPrefs({ sidebarHostGrouping })}
        scopePath={filtering ? '' : scope.path}
        onScopeChange={setScopePath}
        summary={hostSummary(allHosts.length, liveKeys.size)}
        onOpenHostsTab={() => useTabsStore.getState().openHosts()}
      />

      <Box
        ref={scrollRef}
        sx={{ flex: 1, overflowY: 'auto', pb: 1 }}
        // Rows stop this from reaching the panel, so anything that gets here is
        // empty space: the one place a root-level folder can be asked for.
        onContextMenu={(event) => {
          event.preventDefault();
          setPanelMenu({ top: event.clientY, left: event.clientX });
        }}
        // Where a plain click selects a host, a click beside the rows lets go
        // of it, as in a file manager.
        onClick={(event) => {
          if (openGesture !== 'double-click') return;
          if (!(event.target as Element).closest('li, button')) clearSelection();
        }}
      >
        <List dense disablePadding>
          <ListItemButton
            component="li"
            aria-label="Local terminal"
            sx={fixedRowSx}
            onMouseEnter={() => void loadTerminalViewImpl()}
            onFocus={() => void loadTerminalViewImpl()}
            onClick={(event) => {
              if (clickOpensRow(event.detail, openGesture)) openLocalTerminal();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setShellMenu({
                position: { top: event.clientY, left: event.clientX },
                profile: null,
                wsl: false,
              });
            }}
          >
            <TerminalIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.secondary' }} />
            <Box component="span" sx={{ ...treeLabelSx, minWidth: 0, flex: 1 }}>
              Local terminal
            </Box>
            <EnvironmentBadges hostKey={LOCAL_ENVIRONMENT_KEY} />
          </ListItemButton>
          {visibleLocalShellProfiles.map((profile) => (
            <Tooltip
              key={profile.id}
              title={[profile.shell || 'Automatic shell', ...profile.args].join(' ')}
              placement={hoverPlacement}
            >
              <ListItemButton
                component="li"
                sx={[...fixedRowSx, { pl: 3 }]}
                onMouseEnter={() => void loadTerminalViewImpl()}
                onFocus={() => void loadTerminalViewImpl()}
                onClick={(event) => {
                  if (clickOpensRow(event.detail, openGesture)) openLocalShellProfile(profile);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setShellMenu({
                    position: { top: event.clientY, left: event.clientX },
                    profile,
                    wsl: wslShellProfiles.includes(profile),
                  });
                }}
              >
                <LocalShellIcon
                  launch={profile}
                  size={15}
                  fallback={
                    <TerminalIcon sx={{ fontSize: 15, flexShrink: 0, color: 'text.secondary' }} />
                  }
                />
                <Box component="span" sx={{ ...treeLabelSx, minWidth: 0 }}>
                  {profile.name.trim() || 'Unnamed shell'}
                </Box>
              </ListItemButton>
            </Tooltip>
          ))}
          {quickConnectable && (
            <ListItemButton
              component="li"
              sx={fixedRowSx}
              onMouseEnter={() => void loadTerminalViewImpl()}
              onFocus={() => void loadTerminalViewImpl()}
              onClick={(event) => {
                if (!clickOpensRow(event.detail, openGesture)) return;
                connectTarget(filter.trim());
                setFilter('');
              }}
            >
              <BoltIcon sx={{ fontSize: 16, flexShrink: 0 }} color="primary" />
              <Box component="span" sx={{ ...treeLabelSx, minWidth: 0, color: 'primary.main' }}>
                Connect to {filter.trim()}
              </Box>
            </ListItemButton>
          )}
        </List>

        {config?.error && (
          <Alert severity="warning" sx={{ mx: 1, my: 0.5, py: 0, fontSize: 12 }}>
            {config.error}
          </Alert>
        )}

        <HostTree
          ref={treeRef}
          tree={shownTree}
          flat={hostView !== 'tree'}
          hostDetail={hostDetail}
          onBack={
            hostView === 'scope' && scope.path && !filtering
              ? () => setScopePath(folderParentPath(scope.path))
              : undefined
          }
          scrollContainer={scrollRef}
          matchKey={matchKey}
          sessionsMenuKey={sessionsMenu ? managedHostKey(sessionsMenu.host) : undefined}
          selectedKeys={selection}
          onSelectionChange={setSelection}
          isExpanded={isExpandedShown}
          setExpanded={setExpandedShown}
          folderColor={folderColor}
          folderIconId={folderIconId}
          folderLink={folderLink}
          liveByKey={liveByKey}
          // Alt+Arrow moves a host among its siblings, which only the tree shows.
          reorderEnabled={reorderEnabled && hostView === 'tree'}
          openGesture={openGesture}
          onActivate={activateHost}
          onHostMenu={openMenu}
          onFolderMenu={openFolderMenu}
          onLaunch={launchNode}
          onMoveHost={moveHost}
          onMoveFolder={moveFolder}
          // Escape lets go of a selection before it leaves the tree.
          onEscape={() =>
            selection.size > 0 ? clearSelection() : searchRef.current?.focus()
          }
          hoverPlacement={hoverPlacement}
          dnd={dnd.binding}
        />

        {empty && (
          <Stack spacing={1.5} sx={{ alignItems: 'center', p: 3, textAlign: 'center' }}>
            <DnsOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
            <Typography variant="body2" color="textSecondary">
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
            <Typography variant="body2" color="textSecondary">
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

      {selectedHosts.length > 0 ? (
        <SelectionBar
          count={selectedHosts.length}
          onEdit={() => editHosts(selectedHosts)}
          onMove={() => moveHosts(selectedHosts)}
          onDelete={() => requestDeleteHosts(selectedHosts)}
          onRunScript={() => openScriptsFor(selectedHosts, 'The selection')}
          onClear={clearSelection}
        />
      ) : null}

      {(menu || sessionsMenu || folderMenu || panelMenu || shellMenu || launchTarget || addMenu) && (
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
              onDelete: requestDelete,
              // Only offered from a host inside a selection of several.
              selectedCount:
                menu && selection.has(managedHostKey(menu.host)) ? selectedHosts.length : 0,
              onEditSelected: () => editHosts(selectedHosts),
              onMoveSelected: () => moveHosts(selectedHosts),
              onDeleteSelected: () => requestDeleteHosts(selectedHosts),
              onRunScript: (host) => {
                const inSelection = selection.has(managedHostKey(host)) && selectedHosts.length > 1;
                if (inSelection) openScriptsFor(selectedHosts, 'The selection');
                else openScriptsFor([host], 'This host');
              },
              onMoveToFolder: (host) => moveHosts([host]),
            }}
            sessions={{
              menu: sessionsMenu,
              placement: hoverPlacement,
              onClose: () => setSessionsMenu(null),
            }}
            folder={{
              menu: folderMenu,
              onClose: () => setFolderMenu(null),
              onNewHost: (node) => setHostEditor({ mode: 'new', group: node.path }),
              onNewChild: (node) => setFolderDialog({ mode: 'new', parentPath: node.path }),
              onEdit: (node) => setFolderDialog({ mode: 'edit', path: node.path }),
              onLaunch: launchNode,
              onEditHosts: (node) => editHosts(collectHosts(node)),
              onRunScript: (node) => openScriptsFor(collectHosts(node), `“${node.label}”`),
              onCollapseAll: collapseSubtree,
              onDelete: deleteFolder,
              onMove: (node, delta) => moveFolderByKey(node.key, delta),
              onSortHosts: (node) =>
                alphabetizeHosts(
                  node.children.flatMap((child) =>
                    child.kind === 'host' ? [child.host] : [],
                  ),
                ),
              canMoveUp: reorderEnabled && folderMenuPosition.index > 0,
              canMoveDown:
                reorderEnabled &&
                folderMenuPosition.index >= 0 &&
                folderMenuPosition.index < folderMenuPosition.total - 1,
              canSortHosts: reorderEnabled && folderMenuHostCount > 1,
              link: folderMenuLink,
              linkBusy: !!folderMenuLink && sharedSessionsBeingRead.has(folderMenuLink.id),
              onRefreshLink: (link) => void refreshSharedSessionsNow(queryClient, link),
              onEditLink: (link) => setSharedSessionsDialog({ mode: 'link', sourceId: link.id }),
              onShare: (node) => setSharedSessionsDialog({ mode: 'share', path: node.path }),
              onStopFollowing: (link) =>
                void confirmRemoveSharedSessions(link).then((answer) => {
                  if (answer) stopFollowing.mutate({ id: link.id, keepHosts: answer.keepHosts });
                }),
            }}
            panel={{
              position: panelMenu,
              onClose: () => setPanelMenu(null),
              onNewHost: () => setHostEditor({ mode: 'new' }),
              onNewFolder: () => setFolderDialog({ mode: 'new' }),
              onFollowLink: () => setSharedSessionsDialog({ mode: 'link' }),
              onSortHosts: () => alphabetizeHosts(allHosts),
              folderEditsEnabled,
              canSortHosts: reorderEnabled && allHosts.length > 1,
              sidebarPosition,
              onMoveSidebar: () =>
                setPrefs({ sidebarPosition: onRight ? 'left' : 'right' }),
            }}
            shell={{ menu: shellMenu, onClose: () => setShellMenu(null) }}
            launch={{ target: launchTarget, onClose: () => setLaunchTarget(null) }}
            add={{
              anchor: addMenu,
              onClose: () => setAddMenu(null),
              onNewHost: () => setHostEditor({ mode: 'new' }),
              onNewFolder: () => setFolderDialog({ mode: 'new' }),
              onFollowLink: () => setSharedSessionsDialog({ mode: 'link' }),
              folderEditsEnabled,
            }}
          />
        </Suspense>
      )}
    </Box>
  );
});

/** "13 hosts · 3 open": what the bar above the tree says. */
function hostSummary(total: number, open: number): string {
  const hosts = `${total} host${total === 1 ? '' : 's'}`;
  return open > 0 ? `${hosts} · ${open} open` : hosts;
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
