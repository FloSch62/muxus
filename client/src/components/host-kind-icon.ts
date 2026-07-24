import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';

/** The one icon per connection kind, shared by every host listing. */
export function hostKindIcon(kind: 'ssh' | 'telnet' | 'serial'): ComponentType<SvgIconProps> {
  if (kind === 'telnet') return LanguageOutlinedIcon;
  if (kind === 'serial') return UsbOutlinedIcon;
  return DnsOutlinedIcon;
}
