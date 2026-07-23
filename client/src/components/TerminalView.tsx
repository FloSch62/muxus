import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import type { SessionTab } from '../state/tabs.js';
import { usePrefsStore } from '../state/prefs.js';
import { terminalScheme } from '../terminal/palette.js';
import { loadTerminalViewImpl } from '../lazy-features.js';

const TerminalViewImpl = lazy(loadTerminalViewImpl);

/** Thin Suspense wrapper so xterm and its terminal addons stay off the first paint. */
export function TerminalView({ tab, active }: { tab: SessionTab; active: boolean }) {
  const schemeId = usePrefsStore((s) => s.terminalScheme);
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: terminalScheme(schemeId).theme.background }} />}>
      <TerminalViewImpl tab={tab} active={active} />
    </Suspense>
  );
}
