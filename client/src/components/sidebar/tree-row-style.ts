import type { SxProps, Theme } from '@mui/material/styles';
import { MAX_INDENT_DEPTH } from '../../host-tree.js';

/** One entry of an `sx` array: the object or callback form, never an array. */
type SxEntry = Exclude<SxProps<Theme>, readonly unknown[]>;

/** One line of text, tight enough that nesting still leaves rows on screen. */
export const TREE_ROW_HEIGHT = 26;
export const TREE_INDENT_STEP = 14;
export const TREE_BASE_INSET = 8;

/**
 * Label typography every row shares — hosts, folders and the fixed rows above
 * the tree all read from here so they cannot drift apart. The 450 weight and
 * slight negative tracking need the bundled variable Inter; a fallback font
 * just rounds them off.
 */
export const treeLabelSx = {
  fontSize: 13,
  fontWeight: 450,
  letterSpacing: -0.1,
  color: 'sidebarInk',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** Where a row's content starts, clamped so deep trees keep a usable name column. */
export function indentPx(depth: number): number {
  return TREE_BASE_INSET + Math.min(depth, MAX_INDENT_DEPTH) * TREE_INDENT_STEP;
}

/**
 * Indent guides drawn as stacked gradients rather than nested elements: one
 * hairline per ancestor, plus a thicker line in the folder's colour for the
 * nearest coloured one. No extra DOM, and the lines stay pixel-aligned as the
 * sidebar resizes.
 */
export function indentGuides(
  theme: Theme,
  depth: number,
  railColor: string | undefined,
):
  | {
      backgroundImage: string;
      backgroundRepeat: string;
      backgroundPosition: string;
      backgroundSize: string;
    }
  | undefined {
  const levels = Math.min(depth, MAX_INDENT_DEPTH);
  if (levels === 0) return undefined;
  const layers: string[] = [];
  const positions: string[] = [];
  const sizes: string[] = [];
  for (let level = 0; level < levels; level++) {
    // The innermost guide marks this row's own parent, so it carries the colour.
    const innermost = level === levels - 1;
    const color = innermost && railColor ? railColor : theme.palette.divider;
    const width = innermost && railColor ? 2 : 1;
    layers.push(`linear-gradient(${color}, ${color})`);
    positions.push(`${TREE_BASE_INSET + level * TREE_INDENT_STEP + 6}px 0`);
    // Position and size must stay separate properties: packing them into the
    // `x y / w h` shorthand makes the browser drop backgroundSize, and the
    // gradient then fills the entire row.
    sizes.push(`${width}px 100%`);
  }
  return {
    backgroundImage: layers.join(', '),
    backgroundRepeat: 'no-repeat',
    backgroundPosition: positions.join(', '),
    backgroundSize: sizes.join(', '),
  };
}

/**
 * Shared geometry for every row in the tree, whatever it holds. Returns the
 * callback form specifically so callers can put it first in an `sx` array.
 */
export function treeRowSx(depth: number, railColor: string | undefined): SxEntry {
  return (theme) => ({
    minHeight: TREE_ROW_HEIGHT,
    py: 0.25,
    pr: 0.5,
    pl: `${indentPx(depth)}px`,
    position: 'relative',
    userSelect: 'none',
    contentVisibility: 'auto',
    containIntrinsicSize: `0 ${TREE_ROW_HEIGHT}px`,
    ...indentGuides(theme, depth, railColor),
  });
}
