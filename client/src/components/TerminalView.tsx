import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import type { TerminalTab } from '../state/tabs.js';
import { TERMINAL_BACKGROUND } from '../terminal/palette.js';

const TerminalViewImpl = lazy(() => import('./TerminalViewImpl.js'));

/** Thin Suspense wrapper so xterm and the kitty engines stay off the first paint. */
export function TerminalView({ tab, active }: { tab: TerminalTab; active: boolean }) {
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: TERMINAL_BACKGROUND }} />}>
      <TerminalViewImpl tab={tab} active={active} />
    </Suspense>
  );
}
