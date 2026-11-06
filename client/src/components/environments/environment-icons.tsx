import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import type { EnvironmentBadgeKind } from '../../environments.js';
import containerlabDarkLogo from './logos/containerlab-dark.svg';
import containerlabLogo from './logos/containerlab.svg';
import dockerLogo from './logos/docker.svg';
import kubernetesLogo from './logos/kubernetes.svg';
import libvirtLogo from './logos/libvirt.svg';
import podmanLogo from './logos/podman.svg';
import proxmoxLogo from './logos/proxmox.svg';

export interface EnvironmentKindStyle {
  /** The project's own mark. */
  logo: string;
  /** Its variant for the dark theme, where the mark has one. */
  logoDark?: string;
  label: string;
}

export const ENVIRONMENT_KINDS: Record<EnvironmentBadgeKind, EnvironmentKindStyle> = {
  docker: { logo: dockerLogo, label: 'Docker' },
  podman: { logo: podmanLogo, label: 'Podman' },
  containerlab: { logo: containerlabLogo, logoDark: containerlabDarkLogo, label: 'Containerlab' },
  kubernetes: { logo: kubernetesLogo, label: 'Kubernetes' },
  proxmox: { logo: proxmoxLogo, label: 'Proxmox VE' },
  libvirt: { logo: libvirtLogo, label: 'libvirt' },
};

/** A tool's logo, decorative: the line or tooltip beside it names the tool. */
export function EnvironmentLogo({ kind, size = 16 }: { kind: EnvironmentBadgeKind; size?: number }) {
  // Muxus's theme, not the system's: a mark's own media query would follow the OS.
  const dark = useTheme().palette.mode === 'dark';
  const style = ENVIRONMENT_KINDS[kind];
  return (
    <Box
      component="img"
      src={dark && style.logoDark ? style.logoDark : style.logo}
      alt=""
      aria-hidden
      draggable={false}
      sx={{ width: size, height: size, objectFit: 'contain', display: 'block', flexShrink: 0 }}
    />
  );
}
