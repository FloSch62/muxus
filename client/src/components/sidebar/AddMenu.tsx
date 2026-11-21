import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderSharedOutlinedIcon from '@mui/icons-material/FolderSharedOutlined';
import { loadFolderDialog, loadHostEditorDialog } from '../../lazy-features.js';

/**
 * What the header's + adds: a host, a folder, or a shared sessions link
 * whose hosts Muxus then keeps up to date. The host stays first, so + and
 * Enter is all it takes.
 */
export function AddMenu({
  anchor,
  onClose,
  onNewHost,
  onNewFolder,
  onFollowLink,
  folderEditsEnabled,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onNewHost: () => void;
  onNewFolder: () => void;
  onFollowLink: () => void;
  /** Folder paths are rewritten across the full list, never a filtered one. */
  folderEditsEnabled: boolean;
}) {
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <Menu
      open={!!anchor}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <MenuItem
        onMouseEnter={() => void loadHostEditorDialog()}
        onFocus={() => void loadHostEditorDialog()}
        onClick={run(onNewHost)}
      >
        <ListItemIcon>
          <DnsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        New host…
      </MenuItem>
      <MenuItem
        disabled={!folderEditsEnabled}
        onMouseEnter={() => void loadFolderDialog()}
        onFocus={() => void loadFolderDialog()}
        onClick={run(onNewFolder)}
      >
        <ListItemIcon>
          <CreateNewFolderOutlinedIcon fontSize="small" />
        </ListItemIcon>
        New folder…
      </MenuItem>
      <MenuItem onClick={run(onFollowLink)}>
        <ListItemIcon>
          <FolderSharedOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Shared sessions link…
      </MenuItem>
    </Menu>
  );
}
