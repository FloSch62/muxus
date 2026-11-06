import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import FolderSharedOutlinedIcon from '@mui/icons-material/FolderSharedOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import ScreenShareOutlinedIcon from '@mui/icons-material/ScreenShareOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import SubjectOutlinedIcon from '@mui/icons-material/SubjectOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import WidgetsOutlinedIcon from '@mui/icons-material/WidgetsOutlined';
import type { SavedHostProfile, SessionProfile } from '@muxus/shared';

/** The one icon per connection kind, shared by every host listing. */
export function hostKindIcon(kind: SavedHostProfile['kind']): ComponentType<SvgIconProps> {
  if (kind === 'telnet') return LanguageOutlinedIcon;
  if (kind === 'serial') return UsbOutlinedIcon;
  if (kind === 'rdp') return DesktopWindowsOutlinedIcon;
  if (kind === 'vnc') return ScreenShareOutlinedIcon;
  if (kind === 'gnmi') return SensorsOutlinedIcon;
  if (kind === 'netconf') return AccountTreeOutlinedIcon;
  if (kind === 'web') return PublicOutlinedIcon;
  if (kind === 'winrm') return TerminalOutlinedIcon;
  if (kind === 'smb') return FolderSharedOutlinedIcon;
  if (kind === 'nfs') return StorageOutlinedIcon;
  return DnsOutlinedIcon;
}

/** Tabs into a container, pod or VM console show what they entered, not how. */
export function environmentTabIcon(profile: SessionProfile): ComponentType<SvgIconProps> | undefined {
  if ((profile.kind !== 'local' && profile.kind !== 'ssh') || !profile.environment) return undefined;
  switch (profile.environment.kind) {
    case 'container':
      return ViewInArOutlinedIcon;
    case 'pod':
      return WidgetsOutlinedIcon;
    case 'container-logs':
    case 'pod-logs':
      return SubjectOutlinedIcon;
    default:
      return ComputerOutlinedIcon;
  }
}
