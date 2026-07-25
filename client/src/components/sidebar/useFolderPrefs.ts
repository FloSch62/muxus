import { useCallback, useMemo } from 'react';
import {
  folderKey,
  isDescendantPath,
  isSamePath,
  normalizeGroupPath,
  renameFolderPath,
} from '../../host-tree.js';
import { usePrefsStore, type FolderStyle } from '../../state/prefs.js';

export interface FolderPrefs {
  /** Collapsed folder keys, as a set for the flattener. */
  collapsedKeys: Set<string>;
  /** A folder absent from the collapsed set is expanded, so new ones open. */
  isExpanded: (key: string) => boolean;
  toggleFolder: (key: string) => void;
  setCollapsed: (key: string, collapsed: boolean) => void;
  folderStyle: (key: string) => FolderStyle | undefined;
  setFolderStyle: (key: string, style: FolderStyle | undefined) => void;
  /** Manual sibling order under a parent key, or undefined for alphabetical. */
  folderOrder: (parentKey: string) => readonly string[] | undefined;
  setFolderOrder: (parentKey: string, keys: readonly string[]) => void;
  emptyFolders: string[];
  addEmptyFolder: (path: string) => void;
  removeEmptyFolder: (path: string) => void;
  /** Carry collapse state, colours and empty markers across a folder rename. */
  renameFolderPrefs: (from: string, to: string) => void;
}

export function useFolderPrefs(): FolderPrefs {
  // Selectors return the stored arrays and records verbatim: zustand v5
  // compares with Object.is, so deriving here would allocate every render.
  const collapsedFolders = usePrefsStore((state) => state.sidebarCollapsedFolders);
  const folderStyles = usePrefsStore((state) => state.sidebarFolderStyles);
  const folderOrders = usePrefsStore((state) => state.sidebarFolderOrder);
  const emptyFolders = usePrefsStore((state) => state.sidebarEmptyFolders);
  const set = usePrefsStore((state) => state.set);

  const collapsedKeys = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);

  const setCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      const current = usePrefsStore.getState().sidebarCollapsedFolders;
      const has = current.includes(key);
      if (has === collapsed) return;
      set({
        sidebarCollapsedFolders: collapsed
          ? [...current, key]
          : current.filter((entry) => entry !== key),
      });
    },
    [set],
  );

  const toggleFolder = useCallback(
    (key: string) => setCollapsed(key, !usePrefsStore.getState().sidebarCollapsedFolders.includes(key)),
    [setCollapsed],
  );

  const setFolderStyle = useCallback(
    (key: string, style: FolderStyle | undefined) => {
      const current = usePrefsStore.getState().sidebarFolderStyles;
      const next = { ...current };
      if (!style || (!style.color && !style.icon)) delete next[key];
      else next[key] = style;
      set({ sidebarFolderStyles: next });
    },
    [set],
  );

  const setFolderOrder = useCallback(
    (parentKey: string, keys: readonly string[]) => {
      const current = usePrefsStore.getState().sidebarFolderOrder;
      set({ sidebarFolderOrder: { ...current, [parentKey]: [...keys] } });
    },
    [set],
  );

  const addEmptyFolder = useCallback(
    (path: string) => {
      const normalized = normalizeGroupPath(path);
      if (!normalized) return;
      const current = usePrefsStore.getState().sidebarEmptyFolders;
      if (current.some((entry) => isSamePath(entry, normalized))) return;
      set({ sidebarEmptyFolders: [...current, normalized] });
    },
    [set],
  );

  const removeEmptyFolder = useCallback(
    (path: string) => {
      const current = usePrefsStore.getState().sidebarEmptyFolders;
      const next = current.filter(
        (entry) => !isSamePath(entry, path) && !isDescendantPath(entry, path),
      );
      if (next.length !== current.length) set({ sidebarEmptyFolders: next });
    },
    [set],
  );

  /**
   * Rewrites the folder itself and everything under it. Running this before the
   * network call keeps a renamed folder's colour and expansion in place while
   * the host list reflows underneath it.
   */
  const renameFolderPrefs = useCallback(
    (from: string, to: string) => {
      const state = usePrefsStore.getState();
      const target = normalizeGroupPath(to);
      // A folder key is its lowercased path, so descendants can be rewritten in
      // key space. The trailing separator keeps this segment-safe: the key for
      // "Production" does not start with "folder:prod/".
      const fromKey = folderKey(from);
      const toKey = folderKey(target);
      const remapKey = (key: string): string =>
        key === fromKey
          ? toKey
          : key.startsWith(`${fromKey}/`)
            ? `${toKey}${key.slice(fromKey.length)}`
            : key;
      set({
        sidebarCollapsedFolders: [...new Set(state.sidebarCollapsedFolders.map(remapKey))],
        sidebarFolderStyles: Object.fromEntries(
          Object.entries(state.sidebarFolderStyles).map(([key, style]) => [remapKey(key), style]),
        ),
        // Both sides of the order map hold folder keys: the parent it is stored
        // under, and every sibling listed inside it.
        sidebarFolderOrder: Object.fromEntries(
          Object.entries(state.sidebarFolderOrder).map(([parentKey, keys]) => [
            remapKey(parentKey),
            keys.map(remapKey),
          ]),
        ),
        sidebarEmptyFolders: [
          ...new Set(
            state.sidebarEmptyFolders.map((path) => renameFolderPath(path, from, target) ?? path),
          ),
        ],
      });
    },
    [set],
  );

  return {
    collapsedKeys,
    isExpanded: useCallback((key: string) => !collapsedKeys.has(key), [collapsedKeys]),
    toggleFolder,
    setCollapsed,
    folderStyle: useCallback((key: string) => folderStyles[key], [folderStyles]),
    setFolderStyle,
    folderOrder: useCallback((parentKey: string) => folderOrders[parentKey], [folderOrders]),
    setFolderOrder,
    emptyFolders,
    addEmptyFolder,
    removeEmptyFolder,
    renameFolderPrefs,
  };
}
