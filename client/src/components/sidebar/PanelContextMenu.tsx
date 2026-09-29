import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import { loadFolderDialog, loadHostEditorDialog } from '../../lazy-features.js';

/**
 * Right-click anywhere the rows are not. Creating a folder lives here rather
 * than in the header: it is a rare action next to searching, and the header has
 * only so much width to spend before the search box stops saying what it does.
 */
export function PanelContextMenu({
  position,
  onClose,
  onNewHost,
  onNewFolder,
  onSortHosts,
  folderEditsEnabled,
  canSortHosts,
}: {
  position: { top: number; left: number } | null;
  onClose: () => void;
  onNewHost: () => void;
  onNewFolder: () => void;
  onSortHosts: () => void;
  /** Folder paths are rewritten across the full list, never a filtered one. */
  folderEditsEnabled: boolean;
  /** Sorting is only safe against the complete, settled host list. */
  canSortHosts: boolean;
}) {
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <Menu
      open={!!position}
      anchorReference="anchorPosition"
      anchorPosition={position ?? undefined}
      onClose={onClose}
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
      <Divider />
      <MenuItem disabled={!canSortHosts} onClick={run(onSortHosts)}>
        <ListItemIcon>
          <SortByAlphaIcon fontSize="small" />
        </ListItemIcon>
        Sort all hosts alphabetically
      </MenuItem>
    </Menu>
  );
}
