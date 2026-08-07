import { memo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { activateCommandButton } from '../command-buttons.js';
import { usePrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle } from '../terminal/terminal-registry.js';

export const ActionBar = memo(function ActionBar() {
  const buttons = usePrefsStore((state) => state.commandButtons);
  const showCommandBar = usePrefsStore((state) => state.showCommandBar);
  const activeTab = useTabsStore((state) => state.tabs.find((tab) => tab.id === state.activeId));
  const setOpen = useUiStore((state) => state.setCommandButtonsOpen);
  if (!showCommandBar || buttons.length === 0) return null;
  const connected = activeTab?.status === 'connected';

  return (
    <Box
      aria-label="Saved command buttons"
      sx={{
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        overflowX: 'auto',
        bgcolor: 'sidebar',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      {buttons.map((button) => (
        <Tooltip
          key={button.id}
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
      <Tooltip title="Manage command buttons">
        <IconButton
          size="small"
          aria-label="Manage command buttons"
          onClick={() => setOpen(true)}
          sx={{ ml: 'auto' }}
        >
          <SettingsOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
});
