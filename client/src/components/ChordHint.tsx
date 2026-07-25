import Typography from '@mui/material/Typography';

/**
 * Trailing keyboard hint inside a menu item. Every hint in the app renders
 * through this, in the same monospace tier, from a chord read out of the live
 * keymap — so rebinding a command updates the menu that advertises it.
 */
export function ChordHint({ chord }: { chord?: string }) {
  if (!chord) return null;
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ ml: 3, fontFamily: '"JetBrains Mono", monospace', whiteSpace: 'nowrap' }}
    >
      {chord}
    </Typography>
  );
}

/** Tooltip form of the same hint: "New tab · Ctrl+Shift+T". */
export function withChord(label: string, chord: string | undefined): string {
  return chord ? `${label} · ${chord}` : label;
}
