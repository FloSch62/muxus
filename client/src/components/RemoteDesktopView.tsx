import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import type { DesktopProfile } from '@muxus/shared';
import type { SessionTab } from '../state/tabs.js';
import { loadRemoteDesktopViewImpl } from '../lazy-features.js';

const RemoteDesktopViewImpl = lazy(() =>
  loadRemoteDesktopViewImpl().then((module) => ({ default: module.RemoteDesktopViewImpl })),
);

/** Suspense wrapper so the RDP/VNC clients load only when a desktop tab opens. */
export function RemoteDesktopView({
  tab,
  profile,
  active,
}: {
  tab: SessionTab;
  profile: DesktopProfile;
  active: boolean;
}) {
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: '#101014' }} />}>
      <RemoteDesktopViewImpl tab={tab} profile={profile} active={active} />
    </Suspense>
  );
}
