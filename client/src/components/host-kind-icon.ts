import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import ScreenShareOutlinedIcon from '@mui/icons-material/ScreenShareOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import type { SavedHostProfile } from '@muxus/shared';

/** The one icon per connection kind, shared by every host listing. */
export function hostKindIcon(kind: SavedHostProfile['kind']): ComponentType<SvgIconProps> {
  if (kind === 'telnet') return LanguageOutlinedIcon;
  if (kind === 'serial') return UsbOutlinedIcon;
  if (kind === 'rdp') return DesktopWindowsOutlinedIcon;
  if (kind === 'vnc') return ScreenShareOutlinedIcon;
  if (kind === 'gnmi') return SensorsOutlinedIcon;
  if (kind === 'netconf') return AccountTreeOutlinedIcon;
  return DnsOutlinedIcon;
}
