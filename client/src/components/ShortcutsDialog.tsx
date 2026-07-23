import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { useUiStore } from '../state/ui.js';

const SHORTCUTS: Array<[string, string]> = [
  ['New local terminal', `${HOTKEY_MOD_LABEL}Shift+T`],
  ['Find in terminal', `${HOTKEY_MOD_LABEL}Shift+F`],
  ['Copy / Paste', `${HOTKEY_MOD_LABEL}Shift+C / ${HOTKEY_MOD_LABEL}Shift+V`],
  ['Select all', `${HOTKEY_MOD_LABEL}Shift+A`],
  ['Clear scrollback', `${HOTKEY_MOD_LABEL}Shift+K`],
  ['Zoom in / out / reset', `${HOTKEY_MOD_LABEL}Shift+= / - / 0`],
  ['Zoom with mouse', 'Ctrl+Scroll wheel'],
  ['Next / previous tab', 'Ctrl+PageDown / Ctrl+PageUp'],
  ['Toggle sessions sidebar', `${HOTKEY_MOD_LABEL}B`],
  ['Close tab (desktop)', `${HOTKEY_MOD_LABEL}W`],
  ['Cycle tabs (desktop)', 'Ctrl+Tab / Ctrl+Shift+Tab'],
  ['Search next / previous match', 'Enter / Shift+Enter'],
  ['Rename tab', 'Double-click the tab'],
];

export function ShortcutsDialog() {
  const open = useUiStore((state) => state.shortcutsOpen);
  const setOpen = useUiStore((state) => state.setShortcutsOpen);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <KeyboardOutlinedIcon color="primary" />
        Keyboard shortcuts
      </DialogTitle>
      <DialogContent dividers sx={{ px: 3 }}>
        <Stack divider={<Divider flexItem />} spacing={0}>
          {SHORTCUTS.map(([label, keys]) => (
            <Stack key={label} direction="row" spacing={2} sx={{ py: 1.05, alignItems: 'center' }}>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {label}
              </Typography>
              <Box
                component="kbd"
                sx={{
                  m: 0,
                  color: 'text.secondary',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11.5,
                  whiteSpace: 'nowrap',
                }}
              >
                {keys}
              </Box>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => setOpen(false)}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
