import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import type { SessionTab } from '../state/tabs.js';
import { terminalSchemeIdForMode, usePrefsStore } from '../state/prefs.js';
import { terminalScheme, themeWithColorOverrides } from '../terminal/palette.js';
import { loadTerminalViewImpl } from '../lazy-features.js';

const TerminalViewImpl = lazy(loadTerminalViewImpl);

/** Thin Suspense wrapper so xterm and its terminal addons stay off the first paint. */
export function TerminalView({ tab, active }: { tab: SessionTab; active: boolean }) {
  const mode = useTheme().palette.mode;
  const schemeId = usePrefsStore((prefs) => terminalSchemeIdForMode(prefs, mode));
  const backgroundColor = usePrefsStore((s) => s.backgroundColor);
  const background = themeWithColorOverrides(
    terminalScheme(schemeId).theme,
    '',
    backgroundColor,
  ).background;
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: background }} />}>
      <TerminalViewImpl tab={tab} active={active} />
    </Suspense>
  );
}
