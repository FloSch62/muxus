import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import WidgetsOutlinedIcon from '@mui/icons-material/WidgetsOutlined';
import type { EnvironmentBadgeKind } from '../../environments.js';

export interface EnvironmentKindStyle {
  Icon: ComponentType<SvgIconProps>;
  /** Accent that tells the kinds apart; readable on both themes' paper. */
  color: string;
  label: string;
}

export const ENVIRONMENT_KINDS: Record<EnvironmentBadgeKind, EnvironmentKindStyle> = {
  docker: { Icon: ViewInArOutlinedIcon, color: '#3d9be9', label: 'Docker' },
  podman: { Icon: Inventory2OutlinedIcon, color: '#a07ad6', label: 'Podman' },
  containerlab: { Icon: HubOutlinedIcon, color: '#14b8a6', label: 'Containerlab' },
  kubernetes: { Icon: WidgetsOutlinedIcon, color: '#6b8cff', label: 'Kubernetes' },
  proxmox: { Icon: ComputerOutlinedIcon, color: '#e8862f', label: 'Proxmox VE' },
  libvirt: { Icon: ComputerOutlinedIcon, color: '#d9a400', label: 'libvirt' },
};
