import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import { loadFolderDialog, loadHostEditorDialog } from '../../lazy-features.js';
import type { SidebarPosition } from '../../state/prefs.js';

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
  sidebarPosition,
  onMoveSidebar,
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
  sidebarPosition: SidebarPosition;
  /** Dock the sidebar on the other side of the window. */
  onMoveSidebar: () => void;
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
      <Divider />
      <MenuItem onClick={run(onMoveSidebar)}>
        <ListItemIcon>
          {/* The glyph draws its panel on the right; mirrored, it shows the left. */}
          <ViewSidebarOutlinedIcon
            fontSize="small"
            sx={sidebarPosition === 'right' ? { transform: 'scaleX(-1)' } : undefined}
          />
        </ListItemIcon>
        {sidebarPosition === 'right' ? 'Move sidebar to the left' : 'Move sidebar to the right'}
      </MenuItem>
    </Menu>
  );
}
