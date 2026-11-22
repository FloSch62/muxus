import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import type { SessionTab } from '../state/tabs.js';
import {
  terminalSchemeIdForMode,
  useCustomTerminalSchemes,
  usePrefsStore,
} from '../state/prefs.js';
import { terminalScheme, themeWithColorOverrides } from '../terminal/palette.js';
import { loadTerminalViewImpl } from '../lazy-features.js';

const TerminalViewImpl = lazy(loadTerminalViewImpl);

/**
 * The background a terminal has unless its host says otherwise: the scheme
 * for the theme's mode, with the color set in the settings over it.
 */
export function useDefaultTerminalBackground(): string | undefined {
  const mode = useTheme().palette.mode;
  const schemeId = usePrefsStore((prefs) => terminalSchemeIdForMode(prefs, mode));
  const customSchemes = useCustomTerminalSchemes();
  const backgroundColor = usePrefsStore((s) => s.backgroundColor);
  return themeWithColorOverrides(
    terminalScheme(schemeId, customSchemes).theme,
    '',
    backgroundColor,
  ).background;
}

/** Thin Suspense wrapper so xterm and its terminal addons stay off the first paint. */
export function TerminalView({ tab, active }: { tab: SessionTab; active: boolean }) {
  const background = useDefaultTerminalBackground();
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: background }} />}>
      <TerminalViewImpl tab={tab} active={active} />
    </Suspense>
  );
}
