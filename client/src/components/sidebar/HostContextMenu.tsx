import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import { copyToClipboard } from '../../clipboard.js';
import {
  managedHostCopyCommand,
  type ManagedHost,
} from '../../managed-hosts.js';
import {
  connectManagedHost,
  openManagedHostInNewWindow,
} from '../../session-actions.js';
import {
  loadFolderDialog,
  loadHostEditorDialog,
  loadHostOrganizationDialog,
  loadSftpPanel,
  loadTerminalViewImpl,
} from '../../lazy-features.js';
import { showToast } from '../../state/toast.js';
import { useUiStore } from '../../state/ui.js';
import {
  managedHostSupportsSftp,
  openManagedHostSftp,
} from './host-sftp-action.js';

export interface HostMenuState {
  anchor: HTMLElement;
  position?: { top: number; left: number };
  host: ManagedHost;
}

export function HostContextMenu({
  menu,
  onClose,
  canMoveUp,
  canMoveDown,
  onMove,
  onDelete,
  onMoveToFolder,
}: {
  menu: HostMenuState | null;
  onClose: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onDelete: (host: ManagedHost) => void;
  onMoveToFolder: (host: ManagedHost) => void;
}) {
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setHostOrganizer = useUiStore((s) => s.setHostOrganizer);
  const copyAction = menu ? managedHostCopyCommand(menu.host) : undefined;

  /** Every item closes the menu, so each handler is wrapped once here. */
  const run = (action: (host: ManagedHost) => void) => () => {
    if (menu) action(menu.host);
    onClose();
  };

  return (
    <Menu
      open={!!menu}
      anchorEl={menu?.position ? undefined : menu?.anchor}
      anchorReference={menu?.position ? 'anchorPosition' : 'anchorEl'}
      anchorPosition={menu?.position}
      onClose={onClose}
    >
      <MenuItem
        onMouseEnter={() => void loadTerminalViewImpl()}
        onFocus={() => void loadTerminalViewImpl()}
        onClick={run(connectManagedHost)}
      >
        <ListItemIcon>
          <PlayArrowOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Connect
      </MenuItem>
      <MenuItem
        onMouseEnter={() => void loadTerminalViewImpl()}
        onFocus={() => void loadTerminalViewImpl()}
        onClick={run(openManagedHostInNewWindow)}
      >
        <ListItemIcon>
          <OpenInNewOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Open in new window
      </MenuItem>
      {menu && managedHostSupportsSftp(menu.host) ? (
        <MenuItem
          onMouseEnter={() => {
            void loadTerminalViewImpl();
            void loadSftpPanel();
          }}
          onFocus={() => {
            void loadTerminalViewImpl();
            void loadSftpPanel();
          }}
          onClick={run(openManagedHostSftp)}
        >
          <ListItemIcon>
            <FolderOpenOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Open SFTP file browser
        </MenuItem>
      ) : null}
      <MenuItem disabled={!canMoveUp} onClick={run(() => onMove(-1))}>
        <ListItemIcon>
          <KeyboardArrowUpIcon fontSize="small" />
        </ListItemIcon>
        Move up
      </MenuItem>
      <MenuItem disabled={!canMoveDown} onClick={run(() => onMove(1))}>
        <ListItemIcon>
          <KeyboardArrowDownIcon fontSize="small" />
        </ListItemIcon>
        Move down
      </MenuItem>
      <Divider />
      {/* The keyboard and assistive-tech equivalent of dragging a host into a
          folder — the tree must not need a mouse to be organized. */}
      <MenuItem
        onMouseEnter={() => void loadFolderDialog()}
        onFocus={() => void loadFolderDialog()}
        onClick={run(onMoveToFolder)}
      >
        <ListItemIcon>
          <DriveFileMoveOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Move to folder…
      </MenuItem>
      <MenuItem
        onMouseEnter={() => void loadHostOrganizationDialog()}
        onFocus={() => void loadHostOrganizationDialog()}
        onClick={run((host) => setHostOrganizer(host.entry))}
      >
        <ListItemIcon>
          <PaletteOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Organize &amp; color…
      </MenuItem>
      <MenuItem
        onMouseEnter={() => void loadHostEditorDialog()}
        onFocus={() => void loadHostEditorDialog()}
        onClick={run((host) =>
          setHostEditor(
            host.kind === 'ssh'
              ? { mode: 'edit', entry: host.entry }
              : { mode: 'edit-profile', entry: host.entry },
          ),
        )}
      >
        <ListItemIcon>
          <EditOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Edit host
      </MenuItem>
      <MenuItem
        onMouseEnter={() => void loadHostEditorDialog()}
        onFocus={() => void loadHostEditorDialog()}
        onClick={run((host) =>
          setHostEditor(
            host.kind === 'ssh'
              ? { mode: 'duplicate', entry: host.entry }
              : { mode: 'duplicate-profile', entry: host.entry },
          ),
        )}
      >
        <ListItemIcon>
          <LibraryAddOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Duplicate
      </MenuItem>
      <MenuItem
        onClick={run(() => {
          if (!copyAction) return;
          void copyToClipboard(copyAction.text).then((ok) => {
            if (ok) showToast('success', `Copied "${copyAction.text}"`);
          });
        })}
      >
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        {copyAction?.label ?? 'Copy'}
      </MenuItem>
      <Divider />
      <MenuItem onClick={run(onDelete)} sx={{ color: 'error.main' }}>
        <ListItemIcon sx={{ color: 'error.main' }}>
          <DeleteOutlineIcon fontSize="small" />
        </ListItemIcon>
        Delete host
      </MenuItem>
    </Menu>
  );
}
