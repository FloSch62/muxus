import { memo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import { activateCommandButton } from '../command-buttons.js';
import { usePrefsStore, type CommandBarPosition } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle } from '../terminal/terminal-registry.js';

export const ActionBar = memo(function ActionBar({
  position,
}: {
  position: CommandBarPosition;
}) {
  const buttons = usePrefsStore((state) => state.commandButtons);
  const showCommandBar = usePrefsStore((state) => state.showCommandBar);
  const setPrefs = usePrefsStore((state) => state.set);
  const activeTab = useTabsStore((state) => state.tabs.find((tab) => tab.id === state.activeId));
  const setOpen = useUiStore((state) => state.setCommandButtonsOpen);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  if (!showCommandBar || buttons.length === 0) return null;
  const connected = activeTab?.status === 'connected';
  const atBottom = position === 'bottom';
  // Tooltips open toward the panes rather than off the window edge.
  const tooltipPlacement = atBottom ? 'top' : 'bottom';

  return (
    <Box
      aria-label="Saved command buttons"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ top: event.clientY, left: event.clientX });
      }}
      sx={{
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        overflowX: 'auto',
        bgcolor: 'sidebar',
        [atBottom ? 'borderTop' : 'borderBottom']: 1,
        borderColor: 'divider',
      }}
    >
      {buttons.map((button) => (
        <Tooltip
          key={button.id}
          placement={tooltipPlacement}
          title={`${button.command || 'No command'}${button.sendEnter ? ' · runs immediately' : ' · inserts only'}`}
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={!connected || !button.command}
              onClick={() => {
                const sent = activateCommandButton(terminalHandle(activeTab?.id), button);
                if (!sent) showToast('warning', 'The active terminal is not connected.');
              }}
              sx={{ minWidth: 0, whiteSpace: 'nowrap', py: 0.25 }}
            >
              {button.label.trim() || button.command.trim() || 'Command'}
            </Button>
          </span>
        </Tooltip>
      ))}
      <Tooltip title="Manage command buttons" placement={tooltipPlacement}>
        <IconButton
          size="small"
          aria-label="Manage command buttons"
          onClick={() => setOpen(true)}
          sx={{ ml: 'auto' }}
        >
          <SettingsOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        open={!!menu}
        anchorReference="anchorPosition"
        anchorPosition={menu ?? undefined}
        onClose={() => setMenu(null)}
      >
        <MenuItem
          onClick={() => {
            setMenu(null);
            setPrefs({ commandBarPosition: atBottom ? 'top' : 'bottom' });
          }}
        >
          <ListItemIcon>
            {atBottom ? (
              <VerticalAlignTopIcon fontSize="small" />
            ) : (
              <VerticalAlignBottomIcon fontSize="small" />
            )}
          </ListItemIcon>
          {atBottom ? 'Move bar to the top' : 'Move bar to the bottom'}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            setOpen(true);
          }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Manage command buttons…
        </MenuItem>
      </Menu>
    </Box>
  );
});
