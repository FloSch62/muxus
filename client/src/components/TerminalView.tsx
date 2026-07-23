import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import type { TerminalTab } from '../state/tabs.js';
import { usePrefsStore } from '../state/prefs.js';
import { terminalScheme } from '../terminal/palette.js';

const TerminalViewImpl = lazy(() => import('./TerminalViewImpl.js'));

/** Thin Suspense wrapper so xterm and the kitty engines stay off the first paint. */
export function TerminalView({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const schemeId = usePrefsStore((s) => s.terminalScheme);
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: terminalScheme(schemeId).theme.background }} />}>
      <TerminalViewImpl tab={tab} active={active} />
    </Suspense>
  );
}
