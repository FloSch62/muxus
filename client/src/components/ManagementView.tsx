import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import type { ManagementProfile } from '@muxus/shared';
import type { SessionTab } from '../state/tabs.js';
import { loadManagementViewImpl } from '../lazy-features.js';

const ManagementViewImpl = lazy(() =>
  loadManagementViewImpl().then((module) => ({ default: module.ManagementViewImpl })),
);

/** Suspense wrapper so the NETCONF/gNMI workbench (and Monaco) load only when such a tab opens. */
export function ManagementView({
  tab,
  profile,
  active,
}: {
  tab: SessionTab;
  profile: ManagementProfile;
  active: boolean;
}) {
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: 'background.default' }} />}>
      <ManagementViewImpl tab={tab} profile={profile} active={active} />
    </Suspense>
  );
}
