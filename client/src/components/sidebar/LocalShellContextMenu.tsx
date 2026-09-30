import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import { loadSettingsDialog } from '../../lazy-features.js';
import { saveWslShellProfile } from '../../local-shell-launchers.js';
import { openLocalShellProfile, openLocalTerminal } from '../../session-actions.js';
import type { LocalShellProfileConfig } from '../../state/prefs.js';
import { useUiStore } from '../../state/ui.js';

export interface LocalShellMenuState {
  position: { top: number; left: number };
  /** Null for the Local terminal row, which opens the default shell. */
  profile: LocalShellProfileConfig | null;
  /** An installed WSL distribution listed automatically, not a saved profile. */
  wsl: boolean;
}

/** Right-click on Local terminal, a saved shell profile or a WSL distribution. */
export function LocalShellContextMenu({
  menu,
  onClose,
}: {
  menu: LocalShellMenuState | null;
  onClose: () => void;
}) {
  const openSettings = useUiStore((s) => s.openSettings);

  const run = (action: (menu: LocalShellMenuState) => void) => () => {
    if (menu) action(menu);
    onClose();
  };

  return (
    <Menu
      open={!!menu}
      anchorReference="anchorPosition"
      anchorPosition={menu?.position}
      onClose={onClose}
    >
      <MenuItem
        onClick={run(({ profile }) =>
          profile ? openLocalShellProfile(profile) : openLocalTerminal(),
        )}
      >
        <ListItemIcon>
          <TerminalIcon fontSize="small" />
        </ListItemIcon>
        Open
      </MenuItem>
      {menu?.wsl && (
        <MenuItem
          onClick={run(({ profile }) => {
            if (profile) saveWslShellProfile(profile);
          })}
        >
          <ListItemIcon>
            <BookmarkAddOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Save as profile
        </MenuItem>
      )}
      <Divider />
      <MenuItem
        onMouseEnter={() => void loadSettingsDialog()}
        onFocus={() => void loadSettingsDialog()}
        onClick={run(({ profile }) =>
          openSettings({ section: 'local-shells', item: profile?.id }),
        )}
      >
        <ListItemIcon>
          <SettingsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        {menu?.wsl ? 'WSL settings…' : 'Local shell settings…'}
      </MenuItem>
    </Menu>
  );
}
