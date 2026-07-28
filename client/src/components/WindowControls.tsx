import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import CropSquareOutlinedIcon from '@mui/icons-material/CropSquareOutlined';
import FilterNoneOutlinedIcon from '@mui/icons-material/FilterNoneOutlined';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import { layout } from '../theme.js';

const isWailsFrameless =
  window.muxusDesktop?.runtime === 'wails' &&
  window.muxusDesktop.platform !== 'darwin';

/** Caption buttons for Wails' frameless Windows/Linux windows. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWailsFrameless) return;
    void window.muxusDesktop?.isWindowMaximized().then(setMaximized);
  }, []);
  if (!isWailsFrameless) return null;

  const buttonSx = {
    width: 46,
    height: '100%',
    borderRadius: 0,
    color: 'text.primary',
    '--wails-draggable': 'no-drag',
  };

  return (
    <Box
      aria-label="Window controls"
      sx={{
        alignSelf: 'stretch',
        height: layout.topBarHeight,
        display: 'flex',
        mr: -2,
        ml: 0.5,
        '--wails-draggable': 'no-drag',
      }}
    >
      <IconButton
        disableRipple
        aria-label="Minimize window"
        onClick={() => window.muxusDesktop?.minimizeWindow()}
        sx={{ ...buttonSx, '&:hover': { bgcolor: 'action.hover' } }}
      >
        <HorizontalRuleIcon sx={{ fontSize: 17 }} />
      </IconButton>
      <IconButton
        disableRipple
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        onClick={() => {
          void window.muxusDesktop?.toggleMaximizeWindow().then(setMaximized);
        }}
        sx={{ ...buttonSx, '&:hover': { bgcolor: 'action.hover' } }}
      >
        {maximized ? (
          <FilterNoneOutlinedIcon sx={{ fontSize: 14 }} />
        ) : (
          <CropSquareOutlinedIcon sx={{ fontSize: 13 }} />
        )}
      </IconButton>
      <IconButton
        disableRipple
        aria-label="Close window"
        onClick={() => window.muxusDesktop?.closeWindow()}
        sx={{
          ...buttonSx,
          '&:hover': { bgcolor: '#c42b1c', color: '#fff' },
        }}
      >
        <CloseIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Box>
  );
}
