import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import IosShareOutlinedIcon from '@mui/icons-material/IosShareOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import type { SharedSessionSource } from '@muxus/shared';
import type { FolderNode } from '../../host-tree.js';
import {
  loadFolderDialog,
  loadHostBulkEditDialog,
  loadHostEditorDialog,
} from '../../lazy-features.js';

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
  onEditHosts,
  onRunScript,
  onCollapseAll,
  onDelete,
  onMove,
  onSortHosts,
  canMoveUp,
  canMoveDown,
  canSortHosts,
  link,
  linkBusy,
  onRefreshLink,
  onEditLink,
  onStopFollowing,
  onShare,
}: {
  menu: FolderMenuState | null;
  onClose: () => void;
  onNewHost: (node: FolderNode) => void;
  onNewChild: (node: FolderNode) => void;
  onEdit: (node: FolderNode) => void;
  onLaunch: (node: FolderNode) => void;
  /** Edit every host inside, nested folders included, in one go. */
  onEditHosts: (node: FolderNode) => void;
  /** Open Scripts with the folder's SSH hosts, subfolders included. */
  onRunScript: (node: FolderNode) => void;
  onCollapseAll: (node: FolderNode) => void;
  onDelete: (node: FolderNode) => void;
  onMove: (node: FolderNode, delta: -1 | 1) => void;
  onSortHosts: (node: FolderNode) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canSortHosts: boolean;
  /** The shared sessions link this folder follows, when it follows one. */
  link?: SharedSessionSource;
  /** That link is being read right now. */
  linkBusy: boolean;
  onRefreshLink: (link: SharedSessionSource) => void;
  onEditLink: (link: SharedSessionSource) => void;
  onStopFollowing: (link: SharedSessionSource) => void;
  /** Write the folder as a session list for others to follow. */
  onShare: (node: FolderNode) => void;
}) {
  const run = (action: (node: FolderNode) => void) => () => {
    if (menu) action(menu.node);
    onClose();
  };
  const runLink = (action: (link: SharedSessionSource) => void) => () => {
    if (link) action(link);
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
      <MenuItem
        disabled={count === 0}
        onMouseEnter={() => void (count === 1 ? loadHostEditorDialog() : loadHostBulkEditDialog())}
        onFocus={() => void (count === 1 ? loadHostEditorDialog() : loadHostBulkEditDialog())}
        onClick={run(onEditHosts)}
      >
        <ListItemIcon>
          <EditNoteOutlinedIcon fontSize="small" />
        </ListItemIcon>
        {count > 1 ? `Edit ${count} hosts…` : count === 1 ? 'Edit host…' : 'Edit hosts…'}
      </MenuItem>
      <MenuItem disabled={count === 0} onClick={run(onRunScript)}>
        <ListItemIcon>
          <TerminalOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Run script on hosts in this folder…
      </MenuItem>
      <Divider />
      {link
        ? [
            <MenuItem key="refresh-link" disabled={linkBusy} onClick={runLink(onRefreshLink)}>
              <ListItemIcon>
                <RefreshIcon fontSize="small" />
              </ListItemIcon>
              {linkBusy ? 'Reading shared sessions…' : 'Refresh shared sessions'}
            </MenuItem>,
            <MenuItem key="edit-link" onClick={runLink(onEditLink)}>
              <ListItemIcon>
                <LinkOutlinedIcon fontSize="small" />
              </ListItemIcon>
              Edit shared sessions link…
            </MenuItem>,
            <Divider key="link-divider" />,
          ]
        : null}
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
      <MenuItem disabled={count === 0} onClick={run(onShare)}>
        <ListItemIcon>
          <IosShareOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Share folder…
      </MenuItem>
      <Divider />
      {link ? (
        // Deleting the folder would only last until the next check brings it back.
        <MenuItem onClick={runLink(onStopFollowing)} sx={{ color: 'error.main' }}>
          <ListItemIcon sx={{ color: 'error.main' }}>
            <LinkOffOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Stop following…
        </MenuItem>
      ) : (
        <MenuItem onClick={run(onDelete)} sx={{ color: 'error.main' }}>
          <ListItemIcon sx={{ color: 'error.main' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          Delete folder
        </MenuItem>
      )}
    </Menu>
  );
}
