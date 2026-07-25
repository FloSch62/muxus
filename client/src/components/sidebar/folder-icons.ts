import type { SvgIconComponent } from '@mui/icons-material';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';

/**
 * A deliberately short list. Every entry ships in the initial bundle, so this
 * is curated rather than exposing the whole icon set.
 */
export const FOLDER_ICONS: ReadonlyArray<{ id: string; label: string; Icon: SvgIconComponent }> = [
  { id: 'folder', label: 'Folder', Icon: FolderOutlinedIcon },
  { id: 'cloud', label: 'Cloud', Icon: CloudOutlinedIcon },
  { id: 'server', label: 'Servers', Icon: DnsOutlinedIcon },
  { id: 'storage', label: 'Storage', Icon: StorageOutlinedIcon },
  { id: 'router', label: 'Network', Icon: RouterOutlinedIcon },
  { id: 'lan', label: 'LAN', Icon: LanOutlinedIcon },
  { id: 'hub', label: 'Cluster', Icon: HubOutlinedIcon },
  { id: 'public', label: 'Public', Icon: PublicOutlinedIcon },
  { id: 'lock', label: 'Secure', Icon: LockOutlinedIcon },
  { id: 'lab', label: 'Lab', Icon: ScienceOutlinedIcon },
  { id: 'site', label: 'Site', Icon: WarehouseOutlinedIcon },
];

const BY_ID = new Map(FOLDER_ICONS.map((entry) => [entry.id, entry.Icon]));

export function isFolderIconId(id: string): boolean {
  return BY_ID.has(id);
}

/** The plain folder falls back to open/closed art; named icons do not. */
export function folderIcon(id: string | undefined, expanded: boolean): SvgIconComponent {
  if (!id || id === 'folder') return expanded ? FolderOpenOutlinedIcon : FolderOutlinedIcon;
  return BY_ID.get(id) ?? FolderOutlinedIcon;
}
