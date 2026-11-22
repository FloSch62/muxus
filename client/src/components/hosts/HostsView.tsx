import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import { loadHostsViewImpl } from '../../lazy-features.js';

const HostsViewImpl = lazy(() =>
  loadHostsViewImpl().then((module) => ({ default: module.HostsViewImpl })),
);

/** Suspense wrapper so the hosts tab loads only once it is opened. */
export function HostsView({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: 'background.default' }} />}>
      <HostsViewImpl visible={visible} />
    </Suspense>
  );
}
