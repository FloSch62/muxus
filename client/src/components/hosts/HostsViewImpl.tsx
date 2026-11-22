import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CheckIcon from '@mui/icons-material/Check';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import { hostSections, type HostSection } from '../../host-sections.js';
import { tabHostKey } from '../../host-sessions.js';
import { buildHostTree } from '../../host-tree.js';
import {
  HOST_KIND_LABELS,
  formatLastUsed,
  hostsTableRow,
  managedHostKind,
  nextHostsTableSort,
  sortHostsTableRows,
  type HostKind,
  type HostsTableColumn,
  type HostsTableRow,
  type HostsTableSort,
} from '../../hosts-table.js';
import { loadHostEditorDialog, loadTerminalViewImpl } from '../../lazy-features.js';
import {
  bestManagedHostMatch,
  groupManagedHosts,
  managedHostKey,
  type ManagedHost,
} from '../../managed-hosts.js';
import { openScriptsFor } from '../../scripts/script-jobs.js';
import { connectManagedHost, connectTarget, isQuickConnectTarget } from '../../session-actions.js';
import { usePrefsStore, type HostsTabView } from '../../state/prefs.js';
import { useTabsStore } from '../../state/tabs.js';
import { useUiStore } from '../../state/ui.js';
import { EnvironmentBadges } from '../environments/EnvironmentBadges.js';
import { managedHostIcon } from '../host-icon.js';
import { folderIcon } from '../sidebar/folder-icons.js';
import { HostContextMenu, type HostMenuState } from '../sidebar/HostContextMenu.js';
import { HostSessionsMenu, type HostSessionsMenuState } from '../sidebar/HostSessionsMenu.js';
import { hostClickOutcome, type HostActivation } from '../sidebar/row-clicks.js';
import { SelectionBar } from '../sidebar/SelectionBar.js';
import { useAllManagedHosts } from '../sidebar/useAllManagedHosts.js';
import { useFolderPrefs } from '../sidebar/useFolderPrefs.js';
import { useHostActions } from '../sidebar/useHostActions.js';
import { useLiveHostCounts, type LiveCounts } from '../sidebar/useLiveHostCounts.js';
import { HostCard } from './HostCard.js';
import { useHostsDnd } from './useHostsDnd.js';

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const TABLE_ROW_HEIGHT = 32;
const TABLE_COLUMNS =
  '36px minmax(160px, 1.3fr) minmax(200px, 2fr) minmax(120px, 1fr) minmax(90px, 0.8fr) 84px 112px';
const COLUMN_LABELS: Record<HostsTableColumn, string> = {
  name: 'Name',
  address: 'Address',
  folder: 'Folder',
  via: 'Via',
  kind: 'Kind',
  lastUsed: 'Last used',
};
const COLUMNS = Object.keys(COLUMN_LABELS) as HostsTableColumn[];

/**
 * Every saved host as a tab: cards filed under their folders, or one table
 * that sorts by any column. It is the sidebar's list with room to spread out
 * — the same hosts, the same clicks, the same menus — and the place to
 * arrange them: drag a host to another folder or another spot, alone or as a
 * selection, here or across to the sidebar.
 */
export function HostsViewImpl({ visible }: { visible: boolean }) {
  const { data: config, isSuccess: sshConfigReady } = useSshConfig();
  const { data: savedData, isSuccess: savedProfilesReady } = useSavedHostProfiles();
  const hosts = config?.hosts;
  const profiles = savedData?.profiles;
  const folders = useFolderPrefs();
  const allHosts = useAllManagedHosts();
  const liveByKey = useLiveHostCounts();
  const openGesture = usePrefsStore((state) => state.sidebarOpenGesture);
  const mode = usePrefsStore((state) => state.hostsTabView);
  const sort = usePrefsStore((state) => state.hostsTabSort);
  const setPrefs = usePrefsStore((state) => state.set);
  const setHostEditor = useUiStore((state) => state.setHostEditor);

  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const needle = useDeferredValue(normalizedQuery);
  const [kind, setKind] = useState<HostKind | 'all'>('all');
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const [focusedKey, setFocusedKey] = useState<string | undefined>();
  const [menu, setMenu] = useState<HostMenuState | null>(null);
  const [sessionsMenu, setSessionsMenu] = useState<HostSessionsMenuState | null>(null);
  // "Today" in the last-used column is settled once per look at the tab.
  const now = useMemo(() => (visible ? Date.now() : 0), [visible]);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const anchorRef = useRef<string | undefined>(undefined);

  const files = config?.files;
  const configPath = config?.path;
  // The whole tree, never filtered: a drag has to know every host of a folder
  // to settle the order of the ones that stay.
  const tree = useMemo(
    () =>
      buildHostTree(groupManagedHosts(hosts ?? [], profiles ?? [], files ?? [], configPath, ''), {
        knownFolders: folders.emptyFolders,
        folderOrder: folders.folderOrder,
      }),
    [hosts, profiles, files, configPath, folders.emptyFolders, folders.folderOrder],
  );
  const sections = useMemo(() => hostSections(tree), [tree]);
  const hostByKey = useMemo(
    () => new Map(allHosts.map((host) => [managedHostKey(host), host])),
    [allHosts],
  );

  const matching = useMemo(() => {
    if (!needle) return undefined;
    return new Set(
      groupManagedHosts(hosts ?? [], profiles ?? [], files ?? [], configPath, needle).flatMap(
        (group) => group.hosts.map(managedHostKey),
      ),
    );
  }, [hosts, profiles, files, configPath, needle]);
  const shows = useCallback(
    (host: ManagedHost) =>
      (kind === 'all' || managedHostKind(host) === kind) &&
      (!matching || matching.has(managedHostKey(host))),
    [kind, matching],
  );
  const kindCounts = useMemo(() => {
    const counts = new Map<HostKind, number>();
    for (const host of allHosts) {
      const hostKind = managedHostKind(host);
      counts.set(hostKind, (counts.get(hostKind) ?? 0) + 1);
    }
    return counts;
  }, [allHosts]);
  // A kind whose last host is gone must not keep hiding everything.
  useEffect(() => {
    if (kind !== 'all' && !kindCounts.has(kind)) setKind('all');
  }, [kind, kindCounts]);

  const clearSelection = useCallback(() => {
    anchorRef.current = undefined;
    setSelection(EMPTY_KEYS);
  }, []);
  const { editHosts, requestDelete, requestDeleteHosts, moveHosts, commitOrder, dropHosts, mutating } =
    useHostActions(hostByKey, clearSelection);

  const filtering = !!needle || kind !== 'all';
  // Cards always follow the folders; the table does until a column is picked.
  const arranged = mode === 'cards' || !sort.column;
  // Only the hosts' own order, whole, can take a drop that says where to go.
  const droppable = sshConfigReady && savedProfilesReady && !filtering && arranged && !mutating;

  const shownSections = useMemo(
    () => sections.map((section) => ({ section, hosts: section.hosts.filter(shows) })),
    [sections, shows],
  );
  const tableRows = useMemo(
    () =>
      mode === 'table'
        ? new Map(allHosts.map((host) => [managedHostKey(host), hostsTableRow(host, profiles)]))
        : undefined,
    [mode, allHosts, profiles],
  );
  const sortedRows = useMemo(
    () =>
      arranged || !tableRows
        ? []
        : sortHostsTableRows(
            [...tableRows.values()].filter((row) => shows(row.host)),
            sort,
          ),
    [arranged, tableRows, shows, sort],
  );
  const orderedKeys = useMemo(
    () =>
      arranged
        ? shownSections.flatMap((entry) => entry.hosts.map(managedHostKey))
        : sortedRows.map((row) => row.key),
    [arranged, shownSections, sortedRows],
  );
  const selectedHosts = useMemo(
    () => [...selection].flatMap((key) => hostByKey.get(key) ?? []),
    [selection, hostByKey],
  );
  // A deleted host simply drops out of the selection.
  useEffect(() => {
    setSelection((current) => {
      if ([...current].every((key) => hostByKey.has(key))) return current;
      return new Set([...current].filter((key) => hostByKey.has(key)));
    });
  }, [hostByKey]);

  const dnd = useHostsDnd({
    tree,
    sections,
    layout: mode === 'cards' ? 'cards' : 'rows',
    droppable,
    selection,
    scrollRef,
    contentRef,
    onDrop: (plan) => dropHosts(plan.hostKeys, plan.path, plan.order),
  });

  // Read through refs, so the callbacks handed to every card stay the same.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const orderedRef = useRef(orderedKeys);
  orderedRef.current = orderedKeys;
  const gestureRef = useRef(openGesture);
  gestureRef.current = openGesture;

  const openMenu = useCallback(
    (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) =>
      setMenu({ anchor, position, host }),
    [],
  );

  /**
   * The sidebar's click rules: Ctrl/Cmd-click toggles, Shift-click selects a
   * range, and a plain click connects — or selects, where hosts open on a
   * double-click. A host with tabs in this window lists them first.
   */
  const activate = useCallback(
    (host: ManagedHost, anchor: HTMLElement | undefined, gesture: HostActivation) => {
      const key = managedHostKey(host);
      const current = selectionRef.current;
      switch (hostClickOutcome(gesture, gestureRef.current, current.size > 0)) {
        case 'toggle': {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          anchorRef.current = key;
          setSelection(next);
          return;
        }
        case 'extend':
          setSelection(rangeOf(orderedRef.current, anchorRef.current ?? key, key));
          anchorRef.current ??= key;
          return;
        case 'select':
          anchorRef.current = key;
          setSelection(new Set([key]));
          return;
        case 'open': {
          if ((gesture.clicks ?? 0) > 0) anchorRef.current = key;
          const hasSessions = useTabsStore
            .getState()
            .tabs.some((tab) => tabHostKey(tab) === key);
          const repeat = gestureRef.current === 'click' && gesture.repeat;
          if (!anchor || !hasSessions || gesture.newSession || repeat) connectManagedHost(host);
          else setSessionsMenu({ anchor, host, openedAt: performance.now() });
          return;
        }
        case 'ignore':
          return;
      }
    },
    [],
  );
  const toggleSelected = useCallback((key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchorRef.current = key;
  }, []);

  const registerRef = useCallback((key: string) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) itemRefs.current.set(key, element);
        else itemRefs.current.delete(key);
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);

  const tabStop = focusedKey && orderedKeys.includes(focusedKey) ? focusedKey : orderedKeys[0];
  const focusKey = (key: string | undefined) => {
    if (!key) return;
    setFocusedKey(key);
    itemRefs.current.get(key)?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(new Set(orderedKeys));
      return;
    }
    if (event.key === 'Escape') {
      if (selection.size === 0) return;
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key === 'Delete' && !modifier) {
      const targets = selectedHosts.length > 0 ? selectedHosts : hostsOf(hostByKey, tabStop);
      if (targets.length === 0) return;
      event.preventDefault();
      requestDeleteHosts(targets);
      return;
    }
    if (modifier || event.altKey || !tabStop) return;
    const next = neighbourKey(event.key, tabStop, orderedKeys, itemRefs.current, mode);
    if (next === undefined) return;
    event.preventDefault();
    if (event.shiftKey) {
      anchorRef.current ??= tabStop;
      setSelection(rangeOf(orderedKeys, anchorRef.current, next));
    }
    focusKey(next);
  };

  const bestMatch = useMemo(
    () => bestManagedHostMatch(allHosts, normalizedQuery),
    [allHosts, normalizedQuery],
  );
  const onSearchEnter = () => {
    if (bestMatch) connectManagedHost(bestMatch);
    else if (isQuickConnectTarget(query)) connectTarget(query.trim());
    else return;
    setQuery('');
  };

  const total = allHosts.length;
  const shown = orderedKeys.length;
  const draggingHere = dnd.dragging && droppable;
  const renderedSections = shownSections.filter(
    ({ section, hosts: list }) =>
      list.length > 0 ||
      // Mid-drag every folder is somewhere to drop, the empty ones included.
      (draggingHere && section.kind === 'folder'),
  );
  const menuSection = menu
    ? sections.find((section) => section.hosts.includes(menu.host))
    : undefined;
  const menuIndex = menuSection && menu ? menuSection.hosts.indexOf(menu.host) : -1;
  const sectionStyle = (section: HostSection) =>
    section.kind === 'folder' ? folders.folderStyle(section.key) : undefined;

  const itemProps = (host: ManagedHost, key: string) => ({
    hostKey: key,
    host,
    live: liveByKey.get(key),
    selected: selection.has(key),
    focused: key === tabStop,
    dragging: dnd.draggedKeys.has(key),
    onActivate: activate,
    onMenu: openMenu,
    onDragStart: dnd.onDragStart,
    onDragEnd: dnd.onDragEnd,
    registerRef: registerRef(key),
  });

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Stack
        direction="row"
        useFlexGap
        sx={{ flexShrink: 0, flexWrap: 'wrap', alignItems: 'center', gap: 1, px: 2.5, pt: 1.75, pb: 1.25 }}
      >
        <TextField
          inputRef={searchRef}
          placeholder="Search or user@host ⏎"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value.trim()) void loadTerminalViewImpl();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearchEnter();
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusKey(orderedKeys[0]);
            }
          }}
          slotProps={{
            htmlInput: { 'aria-label': 'Search hosts or connect' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ flex: '1 1 240px', maxWidth: 360 }}
        />
        <Stack direction="row" component="fieldset" aria-label="Kind of host" useFlexGap sx={{ gap: 0.75, m: 0, p: 0, border: 0, minWidth: 0, flexWrap: 'wrap' }}>
          <KindChip label="All" count={total} checked={kind === 'all'} onClick={() => setKind('all')} />
          {(Object.keys(HOST_KIND_LABELS) as HostKind[])
            .filter((entry) => kindCounts.has(entry))
            .map((entry) => (
              <KindChip
                key={entry}
                label={HOST_KIND_LABELS[entry]}
                count={kindCounts.get(entry) ?? 0}
                checked={kind === entry}
                onClick={() => setKind(kind === entry ? 'all' : entry)}
              />
            ))}
        </Stack>
        <Box sx={{ flex: 1 }} />
        {mode === 'table' && sort.column ? (
          <Tooltip title="Back to the folders, in the sidebar's order, where rows can be dragged">
            <Button size="small" color="inherit" onClick={() => setPrefs({ hostsTabSort: { descending: false } })}>
              Arrange by folder
            </Button>
          </Tooltip>
        ) : null}
        <Stack
          direction="row"
          component="fieldset"
          aria-label="Layout"
          sx={{ m: 0, p: 0, minWidth: 0, border: 1, borderColor: 'divider', borderRadius: '7px', overflow: 'hidden' }}
        >
          <LayoutToggle mode="cards" current={mode} label="Cards" onChange={(hostsTabView) => setPrefs({ hostsTabView })}>
            <GridViewOutlinedIcon sx={{ fontSize: 16 }} />
          </LayoutToggle>
          <LayoutToggle mode="table" current={mode} label="Table" onChange={(hostsTabView) => setPrefs({ hostsTabView })}>
            <TableRowsOutlinedIcon sx={{ fontSize: 16 }} />
          </LayoutToggle>
        </Stack>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onMouseEnter={() => void loadHostEditorDialog()}
          onFocus={() => void loadHostEditorDialog()}
          onClick={() => setHostEditor({ mode: 'new' })}
        >
          Add host
        </Button>
      </Stack>

      <Box
        ref={scrollRef}
        onKeyDown={onListKeyDown}
        onFocus={(event) => {
          const key = (event.target as HTMLElement).closest<HTMLElement>('[data-host-key]')?.dataset.hostKey;
          if (key) setFocusedKey(key);
        }}
        onClick={(event) => {
          // A click beside the hosts lets go of a selection, as in a file manager.
          if (!(event.target as Element).closest('[data-host-key], button, [role="button"]')) clearSelection();
        }}
        {...dnd.containerProps}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 2.5, pb: 2.5 }}
      >
        <Box ref={contentRef} sx={{ position: 'relative', minWidth: mode === 'table' ? 860 : undefined }}>
          {mode === 'table' ? (
            <TableHeader
              sort={sort}
              allSelected={shown > 0 && orderedKeys.every((key) => selection.has(key))}
              someSelected={selection.size > 0}
              onSort={(column) => setPrefs({ hostsTabSort: nextHostsTableSort(sort, column) })}
              onToggleAll={() =>
                setSelection(
                  orderedKeys.every((key) => selection.has(key)) ? EMPTY_KEYS : new Set(orderedKeys),
                )
              }
            />
          ) : null}

          {arranged
            ? renderedSections.map(({ section, hosts: list }) => {
                const style = sectionStyle(section);
                const accepting = draggingHere && dnd.target?.sectionKey === section.key;
                return (
                  <Box
                    key={section.key}
                    data-section-key={section.key}
                    sx={{ pt: mode === 'cards' ? 1 : 0, pb: mode === 'cards' ? 0.5 : 0 }}
                  >
                    <SectionHeading
                      section={section}
                      count={list.length}
                      color={style?.color}
                      iconId={style?.icon}
                      accepting={accepting}
                      table={mode === 'table'}
                    />
                    {mode === 'cards' ? (
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(212px, 1fr))',
                          gap: 1,
                          minHeight: list.length === 0 ? 36 : undefined,
                        }}
                      >
                        {list.map((host) => {
                          const key = managedHostKey(host);
                          return <HostCard key={key} {...itemProps(host, key)} />;
                        })}
                        {list.length === 0 ? <DropHint accepting={accepting} /> : null}
                      </Box>
                    ) : (
                      <>
                        {list.map((host) => {
                          const key = managedHostKey(host);
                          const row = tableRows?.get(key);
                          return row ? (
                            <HostTableRow key={key} {...itemProps(host, key)} row={row} now={now} onToggleSelected={toggleSelected} />
                          ) : null;
                        })}
                        {list.length === 0 ? <DropHint accepting={accepting} /> : null}
                      </>
                    )}
                  </Box>
                );
              })
            : sortedRows.map((row) => (
                <HostTableRow
                  key={row.key}
                  {...itemProps(row.host, row.key)}
                  row={row}
                  now={now}
                  onToggleSelected={toggleSelected}
                />
              ))}

          {dnd.indicator && draggingHere ? (
            <Box
              aria-hidden
              data-hosts-drop-indicator
              sx={(theme) => ({
                position: 'absolute',
                left: dnd.indicator!.left,
                top: dnd.indicator!.top,
                width: dnd.indicator!.width,
                height: dnd.indicator!.height,
                borderRadius: '2px',
                bgcolor: 'primary.main',
                boxShadow: `0 0 8px ${alpha(theme.palette.primary.main, 0.55)}`,
                pointerEvents: 'none',
                zIndex: 3,
              })}
            />
          ) : null}

          {total === 0 ? (
            <EmptyState
              title="No saved hosts yet."
              action="Add your first host"
              onAction={() => setHostEditor({ mode: 'new' })}
            />
          ) : shown === 0 ? (
            <EmptyState
              title="No hosts match."
              action={query.trim() ? `Add “${query.trim()}”` : undefined}
              onAction={() => setHostEditor({ mode: 'new', prefillTarget: query.trim() })}
            />
          ) : null}
        </Box>
      </Box>

      {selectedHosts.length > 0 ? (
        <Box sx={{ flexShrink: 0, bgcolor: 'sidebar' }}>
          <SelectionBar
            count={selectedHosts.length}
            onEdit={() => editHosts(selectedHosts)}
            onMove={() => moveHosts(selectedHosts)}
            onDelete={() => requestDeleteHosts(selectedHosts)}
            onRunScript={() => openScriptsFor(selectedHosts, 'The selection')}
            onClear={clearSelection}
          />
        </Box>
      ) : null}

      <HostContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        canMoveUp={droppable && menuIndex > 0}
        canMoveDown={droppable && menuIndex >= 0 && menuIndex < (menuSection?.hosts.length ?? 0) - 1}
        onMove={(delta) => {
          if (!menuSection || menuIndex < 0) return;
          const keys = menuSection.hosts.map(managedHostKey);
          const to = menuIndex + delta;
          if (to < 0 || to >= keys.length) return;
          [keys[menuIndex], keys[to]] = [keys[to]!, keys[menuIndex]!];
          commitOrder(keys);
        }}
        onDelete={requestDelete}
        onMoveToFolder={(host) => moveHosts([host])}
        selectedCount={menu && selection.has(managedHostKey(menu.host)) ? selectedHosts.length : 0}
        onEditSelected={() => editHosts(selectedHosts)}
        onMoveSelected={() => moveHosts(selectedHosts)}
        onDeleteSelected={() => requestDeleteHosts(selectedHosts)}
        onRunScript={(host) => {
          const inSelection = selection.has(managedHostKey(host)) && selectedHosts.length > 1;
          if (inSelection) openScriptsFor(selectedHosts, 'The selection');
          else openScriptsFor([host], 'This host');
        }}
      />
      <HostSessionsMenu menu={sessionsMenu} placement="right" onClose={() => setSessionsMenu(null)} />
    </Box>
  );
}

function hostsOf(hostByKey: ReadonlyMap<string, ManagedHost>, key: string | undefined): ManagedHost[] {
  const host = key ? hostByKey.get(key) : undefined;
  return host ? [host] : [];
}

/** Every key from `from` to `to` in the order on screen, both included. */
function rangeOf(keys: readonly string[], from: string, to: string): Set<string> {
  const start = keys.indexOf(from);
  const end = keys.indexOf(to);
  if (end < 0) return new Set();
  const [low, high] = start < 0 ? [end, end] : start <= end ? [start, end] : [end, start];
  return new Set(keys.slice(low, high + 1));
}

/**
 * The host an arrow key moves to. A table is a column; cards wrap, so up and
 * down go to the card nearest above or below on screen.
 */
function neighbourKey(
  pressed: string,
  current: string,
  keys: readonly string[],
  elements: ReadonlyMap<string, HTMLElement>,
  mode: HostsTabView,
): string | undefined {
  const index = keys.indexOf(current);
  if (index < 0) return undefined;
  if (pressed === 'Home') return keys[0];
  if (pressed === 'End') return keys[keys.length - 1];
  const vertical = pressed === 'ArrowUp' || pressed === 'ArrowDown';
  const horizontal = pressed === 'ArrowLeft' || pressed === 'ArrowRight';
  if (!vertical && !horizontal) return undefined;
  if (mode === 'table') {
    if (horizontal) return undefined;
    return keys[index + (pressed === 'ArrowUp' ? -1 : 1)] ?? current;
  }
  if (horizontal) return keys[index + (pressed === 'ArrowLeft' ? -1 : 1)] ?? current;
  const from = elements.get(current)?.getBoundingClientRect();
  if (!from) return undefined;
  const direction = pressed === 'ArrowUp' ? -1 : 1;
  const center = from.left + from.width / 2;
  let best: { key: string; row: number; offset: number } | undefined;
  for (let i = index + direction; i >= 0 && i < keys.length; i += direction) {
    const rect = elements.get(keys[i]!)?.getBoundingClientRect();
    if (!rect || Math.abs(rect.top - from.top) < 2) continue;
    // The first row reached is the one to land in; stop once past it.
    if (best && Math.abs(rect.top - best.row) >= 2) break;
    const offset = Math.abs(rect.left + rect.width / 2 - center);
    if (!best || offset < best.offset) best = { key: keys[i]!, row: rect.top, offset };
  }
  return best?.key ?? current;
}

function KindChip({
  label,
  count,
  checked,
  onClick,
}: {
  label: string;
  count: number;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      aria-pressed={checked}
      onClick={onClick}
      sx={{
        height: 24,
        px: 1.125,
        gap: 0.625,
        borderRadius: '12px',
        border: 1,
        borderColor: 'divider',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: -0.1,
        color: checked ? 'text.primary' : 'text.secondary',
        bgcolor: checked ? 'action.selected' : 'transparent',
        '&:hover': { color: 'text.primary' },
        '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 1 },
      }}
    >
      {label}
      <Box component="span" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </Box>
    </ButtonBase>
  );
}

function LayoutToggle({
  mode,
  current,
  label,
  onChange,
  children,
}: {
  mode: HostsTabView;
  current: HostsTabView;
  label: string;
  onChange: (mode: HostsTabView) => void;
  children: ReactNode;
}) {
  const checked = mode === current;
  return (
    <Tooltip title={label}>
      <ButtonBase
        aria-label={label}
        aria-pressed={checked}
        onClick={() => onChange(mode)}
        sx={{
          width: 30,
          height: 26,
          color: checked ? 'text.primary' : 'text.secondary',
          bgcolor: checked ? 'action.selected' : 'transparent',
          '&:hover': { color: 'text.primary' },
          '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
        }}
      >
        {children}
      </ButtonBase>
    </Tooltip>
  );
}

/** A folder's heading: its icon in its color, its path, and how many hosts it shows. */
function SectionHeading({
  section,
  count,
  color,
  iconId,
  accepting,
  table,
}: {
  section: HostSection;
  count: number;
  color?: string;
  iconId?: string;
  /** Dragged hosts are over this folder and would be filed in it. */
  accepting: boolean;
  table: boolean;
}) {
  const Icon = section.kind === 'folder' ? folderIcon(iconId, true) : DnsOutlinedIcon;
  return (
    <Tooltip title={section.tooltip ?? ''} placement="top-start" enterDelay={600} disableInteractive>
      <Box
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.875,
          height: table ? TABLE_ROW_HEIGHT : 28,
          px: table ? 1.25 : 0.25,
          mb: table ? 0 : 0.5,
          borderRadius: table ? 0 : '6px',
          ...(table ? { borderBottom: `1px solid ${theme.palette.divider}`, mt: 0.75 } : {}),
          bgcolor: accepting ? alpha(theme.palette.primary.main, 0.12) : 'transparent',
          transition: 'background-color 120ms ease',
        })}
      >
        <Icon sx={{ fontSize: 16, flexShrink: 0, color: color ?? 'text.secondary' }} />
        <Box
          component="span"
          sx={{
            fontSize: 13,
            fontWeight: 550,
            letterSpacing: -0.1,
            color: 'sidebarInk',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {section.label}
        </Box>
        <Box component="span" sx={{ fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
          {count}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** What an empty folder says while hosts are in the air. */
function DropHint({ accepting }: { accepting: boolean }) {
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        gridColumn: '1 / -1',
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '8px',
        border: '1px dashed',
        borderColor: accepting ? 'primary.main' : 'divider',
        bgcolor: accepting ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
        color: accepting ? 'primary.main' : 'text.secondary',
        fontSize: 12,
      })}
    >
      Drop here
    </Box>
  );
}

function EmptyState({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction: () => void;
}) {
  return (
    <Stack spacing={1.5} sx={{ alignItems: 'center', py: 6, textAlign: 'center' }}>
      <DnsOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
      <Typography variant="body2" color="textSecondary">
        {title}
      </Typography>
      {action ? (
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onMouseEnter={() => void loadHostEditorDialog()}
          onFocus={() => void loadHostEditorDialog()}
          onClick={onAction}
          sx={{ maxWidth: '100%' }}
        >
          {action}
        </Button>
      ) : null}
    </Stack>
  );
}

function Checkbox({
  checked,
  partial = false,
  label,
  onToggle,
}: {
  checked: boolean;
  /** Some but not all are selected. */
  partial?: boolean;
  label: string;
  onToggle: () => void;
}) {
  const filled = checked || partial;
  return (
    <ButtonBase
      aria-label={label}
      aria-pressed={checked}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      sx={{
        width: 16,
        height: 16,
        mx: 'auto',
        borderRadius: '4px',
        border: '1.5px solid',
        borderColor: filled ? 'primary.main' : 'text.disabled',
        bgcolor: filled ? 'primary.main' : 'transparent',
        color: 'primary.contrastText',
      }}
    >
      {checked ? (
        <CheckIcon sx={{ fontSize: 13 }} />
      ) : partial ? (
        <Box sx={{ width: 8, height: 2, borderRadius: 1, bgcolor: 'currentColor' }} />
      ) : null}
    </ButtonBase>
  );
}

function TableHeader({
  sort,
  allSelected,
  someSelected,
  onSort,
  onToggleAll,
}: {
  sort: HostsTableSort;
  allSelected: boolean;
  someSelected: boolean;
  onSort: (column: HostsTableColumn) => void;
  onToggleAll: () => void;
}) {
  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'grid',
        gridTemplateColumns: TABLE_COLUMNS,
        alignItems: 'center',
        height: TABLE_ROW_HEIGHT,
        bgcolor: 'background.default',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Checkbox
        checked={allSelected}
        partial={someSelected && !allSelected}
        label="Select every host shown"
        onToggle={onToggleAll}
      />
      {COLUMNS.map((column) => {
        const active = sort.column === column;
        const Arrow = sort.descending ? ArrowDownwardIcon : ArrowUpwardIcon;
        return (
          <ButtonBase
            key={column}
            aria-label={`Sort by ${COLUMN_LABELS[column].toLowerCase()}`}
            onClick={() => onSort(column)}
            sx={{
              justifyContent: 'flex-start',
              gap: 0.5,
              height: '100%',
              pr: 1.5,
              fontSize: 12,
              fontWeight: 550,
              letterSpacing: -0.1,
              color: active ? 'text.primary' : 'text.secondary',
              '&:hover': { color: 'text.primary' },
              '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
            }}
          >
            {COLUMN_LABELS[column]}
            {active ? <Arrow sx={{ fontSize: 13 }} /> : null}
          </ButtonBase>
        );
      })}
    </Box>
  );
}

const cellSx = {
  minWidth: 0,
  pr: 1.5,
  fontSize: 13,
  letterSpacing: -0.1,
  color: 'text.secondary',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

interface HostTableRowProps {
  hostKey: string;
  host: ManagedHost;
  row: HostsTableRow;
  now: number;
  live?: LiveCounts;
  selected: boolean;
  focused: boolean;
  dragging: boolean;
  onActivate: (host: ManagedHost, anchor: HTMLElement | undefined, gesture: HostActivation) => void;
  onMenu: (host: ManagedHost, anchor: HTMLElement, position?: { top: number; left: number }) => void;
  onToggleSelected: (key: string) => void;
  onDragStart: (event: DragEvent<HTMLElement>, hostKey: string) => void;
  onDragEnd: () => void;
  registerRef: (element: HTMLElement | null) => void;
}

/** One host as a table row; the same clicks, menu and drag as a card. */
const HostTableRow = memo(function HostTableRow({
  hostKey,
  host,
  row,
  now,
  live,
  selected,
  focused,
  dragging,
  onActivate,
  onMenu,
  onToggleSelected,
  onDragStart,
  onDragEnd,
  registerRef,
}: HostTableRowProps) {
  const Icon = managedHostIcon(host);
  const color = host.entry.metadata?.color;
  const connected = live?.connected ?? 0;
  const connecting = live?.connecting ?? 0;
  const open = connected + connecting > 0;
  return (
    <ButtonBase
      component="div"
      ref={registerRef}
      data-host-key={hostKey}
      aria-label={row.name}
      aria-pressed={selected}
      tabIndex={focused ? 0 : -1}
      draggable
      onDragStart={(event: DragEvent<HTMLElement>) => onDragStart(event, hostKey)}
      onDragEnd={onDragEnd}
      onClick={(event) =>
        onActivate(host, event.currentTarget, {
          newSession: event.shiftKey && event.detail === 0,
          repeat: event.detail > 1,
          clicks: event.detail,
          toggleSelection: event.ctrlKey || event.metaKey,
          extendSelection: event.shiftKey,
        })
      }
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onActivate(host, event.currentTarget, { newSession: true, repeat: false });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(host, event.currentTarget, { top: event.clientY, left: event.clientX });
      }}
      sx={(theme) => ({
        display: 'grid',
        gridTemplateColumns: TABLE_COLUMNS,
        alignItems: 'center',
        justifyContent: 'stretch',
        justifyItems: 'stretch',
        textAlign: 'left',
        width: '100%',
        height: TABLE_ROW_HEIGHT,
        borderBottom: `1px solid ${theme.palette.divider}`,
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.1) : 'transparent',
        opacity: dragging ? 0.4 : 1,
        cursor: 'pointer',
        userSelect: 'none',
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${TABLE_ROW_HEIGHT}px`,
        '&:hover': { bgcolor: selected ? alpha(theme.palette.primary.main, 0.14) : 'action.hover' },
        '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
        '&:hover .host-row-menu, & .host-row-menu:focus-visible': { opacity: 1 },
      })}
    >
      <Checkbox checked={selected} label={`Select ${row.name}`} onToggle={() => onToggleSelected(hostKey)} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, pr: 1.5 }}>
        <Box sx={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
          <Icon sx={{ fontSize: 16, color: color ?? 'text.secondary' }} />
          {open ? (
            <Box
              sx={(theme) => ({
                position: 'absolute',
                right: -3,
                bottom: -2,
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: connected > 0 ? 'success.main' : 'warning.main',
                boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
              })}
            />
          ) : null}
        </Box>
        <Box
          component="span"
          sx={{ ...cellSx, pr: 0, fontWeight: 450, color: 'sidebarInk' }}
        >
          {row.name}
        </Box>
        <EnvironmentBadges hostKey={hostKey} />
      </Box>
      <Box component="span" sx={cellSx}>{row.address}</Box>
      <Box component="span" sx={cellSx}>{row.folder}</Box>
      <Box component="span" sx={cellSx}>{row.via}</Box>
      <Box component="span" sx={cellSx}>{HOST_KIND_LABELS[row.kind]}</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <Box
          component="span"
          sx={(theme) => ({
            ...cellSx,
            flex: 1,
            pr: 0.5,
            ...(open
              ? { color: theme.palette.mode === 'dark' ? theme.palette.success.main : theme.palette.success.dark }
              : {}),
          })}
        >
          {open ? 'Open' : formatLastUsed(row.lastUsed, now)}
        </Box>
        <IconButton
          className="host-row-menu"
          size="small"
          tabIndex={-1}
          aria-label={`Options for ${row.name}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onMenu(host, event.currentTarget);
          }}
          sx={{ flexShrink: 0, p: 0.25, mr: 0.5, opacity: 0, transition: 'opacity 120ms ease' }}
        >
          <MoreVertIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Box>
    </ButtonBase>
  );
});
