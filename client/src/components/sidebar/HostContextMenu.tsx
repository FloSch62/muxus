import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import { useSavedHostProfiles } from '../../api/queries.js';
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
  loadHostBulkEditDialog,
  loadHostEditorDialog,
  loadHostOrganizationDialog,
  loadSftpPanel,
  loadTerminalViewImpl,
} from '../../lazy-features.js';
import { showToast } from '../../state/toast.js';
import { hostDisplayName } from '../../host-organization.js';
import { savedHostDisplayName } from '../../saved-hosts.js';
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
  selectedCount,
  onEditSelected,
  onMoveSelected,
  onDeleteSelected,
}: {
  menu: HostMenuState | null;
  onClose: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onDelete: (host: ManagedHost) => void;
  onMoveToFolder: (host: ManagedHost) => void;
  /** Size of the selection the menu's host belongs to; 0 when it is not selected. */
  selectedCount: number;
  onEditSelected: () => void;
  onMoveSelected: () => void;
  onDeleteSelected: () => void;
}) {
  const setHostEditor = useUiStore((s) => s.setHostEditor);
  const setHostOrganizer = useUiStore((s) => s.setHostOrganizer);
  const { data: savedData } = useSavedHostProfiles();
  const copyAction = menu
    ? managedHostCopyCommand(menu.host, savedData?.profiles)
    : undefined;

  /** Every item closes the menu, so each handler is wrapped once here. */
  const run = (action: (host: ManagedHost) => void) => () => {
    if (menu) action(menu.host);
    onClose();
  };
  // Moving and deleting act on the whole selection the host belongs to, as in
  // a file manager. Editing keeps both, since one host has a fuller editor.
  const forSelection = selectedCount > 1;

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
        onClick={run(forSelection ? onMoveSelected : onMoveToFolder)}
      >
        <ListItemIcon>
          <DriveFileMoveOutlinedIcon fontSize="small" />
        </ListItemIcon>
        {forSelection ? `Move ${selectedCount} selected hosts…` : 'Move to folder…'}
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
      {forSelection ? (
        <MenuItem
          onMouseEnter={() => void loadHostBulkEditDialog()}
          onFocus={() => void loadHostBulkEditDialog()}
          onClick={run(onEditSelected)}
        >
          <ListItemIcon>
            <EditNoteOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit {selectedCount} selected hosts…
        </MenuItem>
      ) : null}
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
      {menu && isSshHost(menu.host) && !forSelection ? (
        <>
          <MenuItem
            onMouseEnter={() => void loadHostEditorDialog()}
            onFocus={() => void loadHostEditorDialog()}
            onClick={run((host) => setHostEditor(managementHostFor(host, 'gnmi')))}
          >
            <ListItemIcon>
              <SensorsOutlinedIcon fontSize="small" />
            </ListItemIcon>
            Add gNMI host for it…
          </MenuItem>
          <MenuItem
            onMouseEnter={() => void loadHostEditorDialog()}
            onFocus={() => void loadHostEditorDialog()}
            onClick={run((host) => setHostEditor(managementHostFor(host, 'netconf')))}
          >
            <ListItemIcon>
              <AccountTreeOutlinedIcon fontSize="small" />
            </ListItemIcon>
            Add NETCONF host for it…
          </MenuItem>
        </>
      ) : null}
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
      <MenuItem
        onClick={run(forSelection ? onDeleteSelected : onDelete)}
        sx={{ color: 'error.main' }}
      >
        <ListItemIcon sx={{ color: 'error.main' }}>
          <DeleteOutlineIcon fontSize="small" />
        </ListItemIcon>
        {forSelection ? `Delete ${selectedCount} selected hosts` : 'Delete host'}
      </MenuItem>
    </Menu>
  );
}

function isSshHost(host: ManagedHost): boolean {
  return host.kind === 'ssh' || host.entry.profile.kind === 'ssh';
}

/**
 * A new gNMI or NETCONF host for the device an SSH host reaches: same
 * address and user, same folder. NETCONF keeps an ssh_config alias as its
 * host so that config's keys and jump hosts still apply.
 */
function managementHostFor(host: ManagedHost, kind: 'gnmi' | 'netconf') {
  const protocol = kind === 'gnmi' ? 'gNMI' : 'NETCONF';
  if (host.kind === 'ssh') {
    const { resolved } = host.entry;
    const target = kind === 'netconf' ? host.entry.alias : resolved.hostname;
    return {
      mode: 'new' as const,
      kind,
      prefillTarget: `${resolved.user ? `${resolved.user}@` : ''}${target}`,
      prefillName: `${hostDisplayName(host.entry)} (${protocol})`,
      group: host.entry.metadata?.group,
    };
  }
  const profile = host.entry.profile;
  // The SSH port means nothing to gNMI or NETCONF: keep only the host.
  const address = profile.kind === 'ssh' ? profile.target.replace(/^[^@]*@/, '') : '';
  const target = address.split(':').length === 2 ? address.split(':')[0]! : address;
  const user = profile.kind === 'ssh' ? (profile.user ?? (profile.target.includes('@') ? profile.target.split('@')[0] : undefined)) : undefined;
  return {
    mode: 'new' as const,
    kind,
    prefillTarget: `${user ? `${user}@` : ''}${target}`,
    prefillName: `${savedHostDisplayName(host.entry)} (${protocol})`,
    group: host.entry.metadata.group,
  };
}
