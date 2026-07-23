import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useAppInfo } from '../api/queries.js';
import { usePrefsStore } from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';

/** Terminal & appearance preferences. Changes apply to newly opened tabs. */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const prefs = usePrefsStore();
  const { data: info } = useAppInfo();

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1.5}>
            <TextField
              select
              label="Theme"
              value={prefs.themeMode}
              onChange={(e) => prefs.set({ themeMode: e.target.value as 'light' | 'dark' | 'os' })}
              fullWidth
            >
              <MenuItem value="os">Follow system</MenuItem>
              <MenuItem value="dark">Dark</MenuItem>
              <MenuItem value="light">Light</MenuItem>
            </TextField>
            <TextField
              label="Font size"
              type="number"
              value={prefs.monoFontSize}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 8 && v <= 32) prefs.set({ monoFontSize: v });
              }}
              sx={{ width: 130 }}
            />
          </Stack>
          <Stack direction="row" spacing={1.5}>
            <TextField
              select
              label="Cursor"
              value={prefs.cursorStyle}
              onChange={(e) => prefs.set({ cursorStyle: e.target.value as 'block' | 'underline' | 'bar' })}
              fullWidth
            >
              <MenuItem value="block">Block</MenuItem>
              <MenuItem value="underline">Underline</MenuItem>
              <MenuItem value="bar">Bar</MenuItem>
            </TextField>
            <TextField
              label="Scrollback"
              type="number"
              value={prefs.scrollback}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 1_000_000) prefs.set({ scrollback: v });
              }}
              sx={{ width: 130 }}
            />
          </Stack>
          <TextField
            label="TERM"
            value={prefs.termName}
            onChange={(e) => prefs.set({ termName: e.target.value })}
            helperText="xterm-kitty enables kitty graphics & keyboard detection; use xterm-256color for hosts without the kitty terminfo entry."
            fullWidth
          />
          <TextField
            label="Local shell"
            value={prefs.localShell}
            onChange={(e) => prefs.set({ localShell: e.target.value })}
            placeholder="auto"
            helperText={info ? `auto = ${info.defaultShell}` : 'auto = your login shell'}
            fullWidth
          />
          <Stack>
            <FormControlLabel
              control={<Switch size="small" checked={prefs.cursorBlink} onChange={(e) => prefs.set({ cursorBlink: e.target.checked })} />}
              label="Cursor blink"
            />
            <FormControlLabel
              control={<Switch size="small" checked={prefs.copyOnSelect} onChange={(e) => prefs.set({ copyOnSelect: e.target.checked })} />}
              label="Copy on select"
            />
          </Stack>
          {info && (
            <Typography variant="caption" color="text.secondary">
              Muxus {info.version} · {String(info.platform)}
            </Typography>
          )}
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
