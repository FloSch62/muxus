import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import MinimizeIcon from '@mui/icons-material/Minimize';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import CloseIcon from '@mui/icons-material/Close';

export function WindowControls() {
  const desktop = window.muxusDesktop;
  if (!desktop || desktop.platform === 'darwin') return null;
  return <Box data-focus-mode-control className="electrobun-webkit-app-region-no-drag" sx={{ display: 'flex', alignSelf: 'stretch', alignItems: 'center', ml: 1 }}>
    <IconButton aria-label="Minimize window" size="small" onClick={() => desktop.minimizeWindow()}><MinimizeIcon fontSize="small" /></IconButton>
    <IconButton aria-label="Maximize or restore window" size="small" onClick={() => desktop.toggleMaximize()}><CropSquareIcon fontSize="small" /></IconButton>
    <IconButton aria-label="Close window" size="small" onClick={() => desktop.closeWindow()} sx={{ '&:hover': { bgcolor: 'error.main', color: 'white' } }}><CloseIcon fontSize="small" /></IconButton>
  </Box>;
}
