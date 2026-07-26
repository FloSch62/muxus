import Typography from '@mui/material/Typography';
import { chordSx } from './chord-style.js';

/**
 * Trailing keyboard hint inside a menu item. Every hint in the app renders
 * through this, in the same typographic tier, from a chord read out of the
 * live keymap — so rebinding a command updates the menu that advertises it.
 */
export function ChordHint({ chord }: { chord?: string }) {
  if (!chord) return null;
  return (
    <Typography variant="caption" color="text.secondary" sx={{ ml: 3, ...chordSx() }}>
      {chord}
    </Typography>
  );
}

/** Tooltip form of the same hint: "New tab · Ctrl+Shift+T". */
export function withChord(label: string, chord: string | undefined): string {
  return chord ? `${label} · ${chord}` : label;
}
