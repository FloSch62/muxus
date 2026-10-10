import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import InputBase from '@mui/material/InputBase';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import {
  formatGnmiElem,
  GnmiPathError,
  parseGnmiPath,
  stripModulePrefix,
  type GnmiPathElem,
} from '@muxus/shared';
import { nodeAt, type DataNode } from '../../management/data-tree.js';
import { useStore } from 'zustand';
import { useWorkbench } from './context.js';
import { MONO_FONT, valueText } from './PathText.js';

interface Suggestion {
  /** Text replacing the segment being typed. */
  insert: string;
  node: DataNode;
  /** Continue typing below it after accepting. */
  branch: boolean;
}

/** Split at the last `/` outside a key predicate: the parent path and the segment being typed. */
export function splitLastSegment(text: string): { parent: string; segment: string } {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') depth++;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (char === '/' && depth === 0) cut = index;
  }
  return { parent: cut < 0 ? '' : text.slice(0, cut), segment: text.slice(cut + 1) };
}

function findChild(node: DataNode, elem: GnmiPathElem): DataNode | undefined {
  const name = stripModulePrefix(elem.name);
  const child = node.children.find(
    (candidate) => candidate.kind !== 'entry' && stripModulePrefix(candidate.name) === name,
  );
  if (!child || !elem.keys) return child;
  return child.children.find(
    (entry) =>
      entry.kind === 'entry' &&
      Object.entries(elem.keys ?? {}).every(([key, value]) => entry.keys?.[key] === value),
  );
}

/** The explorer node a path text leads to, if it was loaded. */
function resolve(root: DataNode, parentText: string): { node?: DataNode; elems?: GnmiPathElem[] } {
  if (!parentText.trim()) return { node: root, elems: [] };
  try {
    const path = parseGnmiPath(parentText);
    let node: DataNode | undefined = root;
    for (const elem of path.elems) {
      node = node ? findChild(node, elem) : undefined;
      if (!node) break;
    }
    return { node, elems: path.elems };
  } catch {
    return {};
  }
}

function suggestionsFor(root: DataNode, text: string): { suggestions: Suggestion[]; parent?: DataNode; elems?: GnmiPathElem[] } {
  const { parent, segment } = splitLastSegment(text);
  const { node, elems } = resolve(root, parent);
  if (!node) return { suggestions: [], elems };
  const bracket = segment.indexOf('[');
  if (bracket >= 0) {
    // Typing a key predicate: offer the list's entries.
    const name = segment.slice(0, bracket);
    const list = node.children.find(
      (child) => child.kind === 'list' && stripModulePrefix(child.name) === stripModulePrefix(name),
    );
    if (!list) return { suggestions: [], parent: node, elems };
    const typed = segment.toLowerCase();
    return {
      parent: node,
      elems,
      suggestions: list.children
        .map((entry) => ({
          insert: formatGnmiElem({ name: stripModulePrefix(entry.name), keys: entry.keys }),
          node: entry,
          branch: true,
        }))
        .filter((suggestion) => suggestion.insert.toLowerCase().startsWith(typed) || typed.endsWith('['))
        .slice(0, 200),
    };
  }
  const typed = segment.toLowerCase();
  // Branches first: completing a path is mostly about the way down.
  const isLeafNode = (child: DataNode) => child.kind === 'leaf' || child.kind === 'leaf-list';
  const children = [
    ...node.children.filter((child) => child.kind !== 'entry' && !isLeafNode(child)),
    ...node.children.filter(isLeafNode),
  ];
  const starts = children.filter((child) => stripModulePrefix(child.name).toLowerCase().startsWith(typed));
  const contains = typed
    ? children.filter(
        (child) =>
          !stripModulePrefix(child.name).toLowerCase().startsWith(typed) &&
          stripModulePrefix(child.name).toLowerCase().includes(typed),
      )
    : [];
  return {
    parent: node,
    elems,
    suggestions: [...starts, ...contains].slice(0, 200).map((child) => ({
      insert: stripModulePrefix(child.name),
      node: child,
      branch: child.kind !== 'leaf' && child.kind !== 'leaf-list',
    })),
  };
}

function SuggestionIcon({ node }: { node: DataNode }) {
  const sx = { fontSize: 14, color: 'text.secondary' } as const;
  if (node.kind === 'list') return <ViewListOutlinedIcon sx={sx} />;
  if (node.kind === 'entry') return <LabelOutlinedIcon sx={sx} />;
  if (node.kind === 'container') return <DataObjectOutlinedIcon sx={sx} />;
  return (
    <Box component="span" sx={{ width: 14, display: 'inline-flex', justifyContent: 'center', color: 'text.disabled' }}>
      <Box component="span" sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'currentColor' }} />
    </Box>
  );
}

/**
 * A gNMI path input that completes from the device's own data: children,
 * list entries with their keys, and leaf values as a preview. Levels the
 * explorer has not loaded yet are fetched as you type.
 */
export function PathField({
  value,
  onChange,
  onRun,
  placeholder = '/interface[name=ethernet-1/1]/statistics',
  focusOnMount,
  ariaLabel,
  endAdornment,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  placeholder?: string;
  /** Take focus when it appears, e.g. right after "Add path". */
  focusOnMount?: boolean;
  ariaLabel: string;
  endAdornment?: React.ReactNode;
}) {
  const { controller, store, connected } = useWorkbench();
  const explorer = useStore(store, (state) => state.explorer);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { suggestions, parent, elems } = useMemo(
    () => suggestionsFor(explorer.root, value),
    // The tree changes in place; `explorer.version` tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [explorer.root, explorer.version, value],
  );
  const syntaxError = useMemo(() => {
    if (!value.trim()) return undefined;
    try {
      parseGnmiPath(value);
      return undefined;
    } catch (err) {
      return err instanceof GnmiPathError ? err.message : String(err);
    }
  }, [value]);

  // Fetch the level being completed when the explorer has not loaded it.
  useEffect(() => {
    if (!focused || !connected) return;
    const timer = setTimeout(() => {
      const state = store.getState();
      let target = parent;
      if (!target && elems) {
        try {
          target = nodeAt(state.explorer.root, { elems }, state.explorer.registry);
        } catch {
          return;
        }
      }
      if (target && !target.loaded && target.kind !== 'leaf' && target.kind !== 'leaf-list') {
        void controller.loadNode(target);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [focused, connected, parent, elems, controller, store]);

  useEffect(() => setHighlighted(0), [value]);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loading = parent ? explorer.loading.has(parent.id) : false;
  const showList = open && focused && (suggestions.length > 0 || loading);

  const accept = (suggestion: Suggestion) => {
    const { parent: parentText } = splitLastSegment(value);
    const prefix = parentText || (value.startsWith('/') || !parentText ? '' : '');
    const next = `${prefix}/${suggestion.insert}${suggestion.branch ? '/' : ''}`;
    onChange(next);
    setOpen(suggestion.branch);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) input.setSelectionRange(next.length, next.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setOpen(false);
      onRun?.();
      return;
    }
    if (!showList) {
      if (event.key === 'ArrowDown') {
        setOpen(true);
        event.preventDefault();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onRun?.();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = suggestions.length;
      if (count === 0) return;
      const next = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      setHighlighted(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[highlighted]) {
      event.preventDefault();
      accept(suggestions[highlighted]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <Box ref={anchorRef} sx={{ flex: 1, minWidth: 0 }}>
      <Box
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          border: 1,
          borderColor: syntaxError ? 'error.main' : focused ? 'primary.main' : 'divider',
          borderRadius: 1,
          px: 1,
          height: 32,
          bgcolor: 'background.paper',
          boxShadow: focused ? `0 0 0 3px ${alpha(syntaxError ? theme.palette.error.main : theme.palette.primary.main, 0.15)}` : 'none',
          transition: 'box-shadow 120ms ease, border-color 120ms ease',
        })}
      >
        <InputBase
          inputRef={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
          inputProps={{
            'aria-label': ariaLabel,
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            role: 'combobox',
            'aria-expanded': showList,
            'aria-autocomplete': 'list',
          }}
          sx={{ flex: 1, fontFamily: MONO_FONT, fontSize: 12.5, '& input': { py: 0 } }}
        />
        {loading && focused && <CircularProgress size={12} />}
        {endAdornment}
      </Box>
      {syntaxError && focused && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.25 }}>
          {syntaxError}
        </Typography>
      )}
      <Popper
        open={showList}
        anchorEl={anchorRef.current}
        placement="bottom-start"
        style={{ zIndex: 1500, width: anchorRef.current?.clientWidth }}
      >
        <Paper
          elevation={8}
          ref={listRef}
          onMouseDown={(event) => event.preventDefault()}
          sx={{ mt: 0.5, maxHeight: 300, overflow: 'auto', py: 0.5, border: 1, borderColor: 'divider' }}
        >
          {suggestions.length === 0 && loading && (
            <Typography variant="caption" color="textSecondary" sx={{ px: 1.5, py: 0.75, display: 'block' }}>
              Asking the device …
            </Typography>
          )}
          {suggestions.map((suggestion, index) => (
            <Box
              key={`${suggestion.node.id}:${suggestion.insert}`}
              data-index={index}
              onClick={() => accept(suggestion)}
              onMouseEnter={() => setHighlighted(index)}
              sx={(theme) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                height: 26,
                cursor: 'pointer',
                fontSize: 12.5,
                bgcolor: index === highlighted ? alpha(theme.palette.primary.main, 0.14) : 'transparent',
              })}
            >
              <SuggestionIcon node={suggestion.node} />
              <Box component="span" sx={{ fontFamily: MONO_FONT, whiteSpace: 'nowrap' }}>
                {suggestion.insert}
              </Box>
              {(suggestion.node.kind === 'leaf' || suggestion.node.kind === 'leaf-list') && (
                <Box
                  component="span"
                  sx={{
                    fontFamily: MONO_FONT,
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {valueText(suggestion.node.value)}
                </Box>
              )}
              {suggestion.node.kind === 'list' && (
                <Box component="span" sx={{ color: 'text.disabled', fontSize: 11 }}>
                  {suggestion.node.children.length} entries
                </Box>
              )}
            </Box>
          ))}
        </Paper>
      </Popper>
    </Box>
  );
}
