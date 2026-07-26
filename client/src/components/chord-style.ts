import { IS_MAC } from '../platform.js';

/**
 * JetBrains Mono carries no glyph for ⌘⇧⌥⌃, so a mono chord label on macOS is
 * drawn from two fonts at once — the symbols come out of a fallback face a
 * size below the letters beside them, which is what makes a row of shortcuts
 * look ragged. macOS renders chords in the system font instead: it has the
 * symbols itself, and it is the face every native Mac menu sets a shortcut
 * in. Elsewhere the mono tier still reads best for "Ctrl+Shift+T".
 */
const CHORD_FONT_FAMILY = IS_MAC
  ? '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
  : '"JetBrains Mono", monospace';

/** The tier chord hints share — MUI's caption at the app's 13px base. */
const CHORD_FONT_SIZE = 11;

/**
 * Chord typography at `size` in that tier. Apple's key symbols have far less
 * ink than Latin letters set at the same pixel size, so macOS gets a bump to
 * keep the chord as readable as the command label next to it.
 */
export function chordSx(size: number = CHORD_FONT_SIZE) {
  return {
    fontFamily: CHORD_FONT_FAMILY,
    fontSize: IS_MAC ? size + 1.5 : size,
    whiteSpace: 'nowrap',
  } as const;
}
