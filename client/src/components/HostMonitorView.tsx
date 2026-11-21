import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import { loadHostMonitorViewImpl } from '../lazy-features.js';

const HostMonitorViewImpl = lazy(() =>
  loadHostMonitorViewImpl().then((module) => ({ default: module.HostMonitorViewImpl })),
);

/** Suspense wrapper so the host monitor loads only once its tab opens. */
export function HostMonitorView({ visible }: { visible: boolean }) {
  return (
    <Suspense fallback={<Box sx={{ height: '100%', bgcolor: 'background.default' }} />}>
      <HostMonitorViewImpl visible={visible} />
    </Suspense>
  );
}
