import Box from '@mui/material/Box';
import type { ReactNode } from 'react';
import { useWslDistributionIcon } from '../local-shell-launchers.js';

/**
 * A local shell's icon: the icon of the WSL distribution it starts, as
 * Windows shows it in the Start menu and Windows Terminal, or `fallback` for
 * any other shell and for distributions that ship none.
 */
export function LocalShellIcon({
  launch,
  size,
  fallback,
  className,
}: {
  launch: { shell?: string; args?: readonly string[] };
  size: number;
  fallback: ReactNode;
  className?: string;
}) {
  const icon = useWslDistributionIcon(launch);
  if (!icon) return fallback;
  return (
    <Box
      component="img"
      src={icon}
      alt=""
      aria-hidden
      draggable={false}
      className={className}
      sx={{ width: size, height: size, flexShrink: 0, objectFit: 'contain' }}
    />
  );
}
