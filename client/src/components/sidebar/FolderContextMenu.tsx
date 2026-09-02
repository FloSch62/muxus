import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import type { FolderNode } from '../../host-tree.js';
import { loadFolderDialog, loadHostEditorDialog } from '../../lazy-features.js';

export interface FolderMenuState {
  anchor: HTMLElement;
  position?: { top: number; left: number };
  node: FolderNode;
}

export function FolderContextMenu({
  menu,
  onClose,
  onNewHost,
  onNewChild,
  onEdit,
  onLaunch,
  onCollapseAll,
  onDelete,
  onMove,
  onSortHosts,
  canMoveUp,
  canMoveDown,
  canSortHosts,
}: {
  menu: FolderMenuState | null;
  onClose: () => void;
  onNewHost: (node: FolderNode) => void;
  onNewChild: (node: FolderNode) => void;
  onEdit: (node: FolderNode) => void;
  onLaunch: (node: FolderNode) => void;
  onCollapseAll: (node: FolderNode) => void;
  onDelete: (node: FolderNode) => void;
  onMove: (node: FolderNode, delta: -1 | 1) => void;
  onSortHosts: (node: FolderNode) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canSortHosts: boolean;
}) {
  const run = (action: (node: FolderNode) => void) => () => {
    if (menu) action(menu.node);
    onClose();
  };
  const count = menu?.node.descendantHostCount ?? 0;

  return (
    <Menu
      open={!!menu}
      anchorEl={menu?.position ? undefined : menu?.anchor}
      anchorReference={menu?.position ? 'anchorPosition' : 'anchorEl'}
      anchorPosition={menu?.position}
      onClose={onClose}
    >
      <MenuItem disabled={count === 0} onClick={run(onLaunch)}>
        <ListItemIcon>
          <PlayArrowOutlinedIcon fontSize="small" />
        </ListItemIcon>
        {count > 0 ? `Launch ${count} host${count === 1 ? '' : 's'}…` : 'Launch hosts…'}
      </MenuItem>
      <Divider />
      <MenuItem disabled={!canMoveUp} onClick={run((node) => onMove(node, -1))}>
        <ListItemIcon>
          <KeyboardArrowUpIcon fontSize="small" />
        </ListItemIcon>
        Move up
      </MenuItem>
      <MenuItem disabled={!canMoveDown} onClick={run((node) => onMove(node, 1))}>
        <ListItemIcon>
          <KeyboardArrowDownIcon fontSize="small" />
        </ListItemIcon>
        Move down
      </MenuItem>
      <MenuItem disabled={!canSortHosts} onClick={run(onSortHosts)}>
        <ListItemIcon>
          <SortByAlphaIcon fontSize="small" />
        </ListItemIcon>
        Sort hosts alphabetically
      </MenuItem>
      <Divider />
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
        onMouseEnter={() => void loadFolderDialog()}
        onFocus={() => void loadFolderDialog()}
        onClick={run(onNewChild)}
      >
        <ListItemIcon>
          <CreateNewFolderOutlinedIcon fontSize="small" />
        </ListItemIcon>
        New folder inside
      </MenuItem>
      <MenuItem
        onMouseEnter={() => void loadFolderDialog()}
        onFocus={() => void loadFolderDialog()}
        onClick={run(onEdit)}
      >
        <ListItemIcon>
          <EditOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Rename, move &amp; style…
      </MenuItem>
      <MenuItem onClick={run(onCollapseAll)}>
        <ListItemIcon>
          <UnfoldLessIcon fontSize="small" />
        </ListItemIcon>
        Collapse all inside
      </MenuItem>
      <Divider />
      <MenuItem onClick={run(onDelete)} sx={{ color: 'error.main' }}>
        <ListItemIcon sx={{ color: 'error.main' }}>
          <DeleteOutlineIcon fontSize="small" />
        </ListItemIcon>
        Delete folder
      </MenuItem>
    </Menu>
  );
}
