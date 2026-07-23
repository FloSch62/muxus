import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import { useAppInfo } from '../api/queries.js';
import { usePrefsStore, type RightClickAction, type ThemeMode } from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';
import { TERMINAL_SCHEMES, type TerminalScheme } from '../terminal/palette.js';

type Section = 'appearance' | 'terminal' | 'behavior' | 'about';

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'appearance', label: 'Appearance', icon: <PaletteOutlinedIcon fontSize="small" /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon fontSize="small" /> },
  { id: 'behavior', label: 'Behavior', icon: <TuneOutlinedIcon fontSize="small" /> },
  { id: 'about', label: 'About', icon: <InfoOutlinedIcon fontSize="small" /> },
];

const FONT_PRESETS = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Consolas',
  'Menlo',
  'Monaco',
  'Source Code Pro',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'monospace',
];

/** All preferences, applied live — including already-open terminals. */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [section, setSection] = useState<Section>('appearance');

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
      <Box sx={{ display: 'flex', height: 560, maxHeight: '80vh' }}>
        <List sx={{ width: 180, flexShrink: 0, borderRight: 1, borderColor: 'divider', py: 1 }}>
          <Typography variant="h6" sx={{ px: 2, py: 1, fontWeight: 700 }}>
            Settings
          </Typography>
          {SECTIONS.map((s) => (
            <ListItemButton key={s.id} selected={section === s.id} onClick={() => setSection(s.id)} sx={{ borderRadius: 1, mx: 1 }}>
              <ListItemIcon sx={{ minWidth: 32 }}>{s.icon}</ListItemIcon>
              <ListItemText primary={s.label} slotProps={{ primary: { variant: 'body2' } }} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, overflowY: 'auto', p: 3, pt: 2.5 }}>
            {section === 'appearance' && <AppearanceSection />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'behavior' && <BehaviorSection />}
            {section === 'about' && <AboutSection />}
          </Box>
          <DialogActions sx={{ borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 1 }}>
              Changes apply immediately, including open terminals.
            </Typography>
            <Button variant="contained" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogActions>
        </Box>
      </Box>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
      {children}
    </Typography>
  );
}

function AppearanceSection() {
  const prefs = usePrefsStore();

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Application theme</SectionTitle>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={prefs.themeMode}
          onChange={(_e, v: ThemeMode | null) => {
            if (v) prefs.set({ themeMode: v });
          }}
        >
          <ToggleButton value="light" sx={{ px: 2 }}>
            Light
          </ToggleButton>
          <ToggleButton value="dark" sx={{ px: 2 }}>
            Dark
          </ToggleButton>
          <ToggleButton value="os" sx={{ px: 2 }}>
            System
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box>
        <SectionTitle>Terminal color scheme</SectionTitle>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1 }}>
          {TERMINAL_SCHEMES.map((scheme) => (
            <SchemeCard
              key={scheme.id}
              scheme={scheme}
              selected={prefs.terminalScheme === scheme.id}
              onSelect={() => prefs.set({ terminalScheme: scheme.id })}
            />
          ))}
        </Box>
      </Box>
      <Box>
        <SectionTitle>Font</SectionTitle>
        <Stack spacing={2}>
          <Autocomplete
            freeSolo
            options={FONT_PRESETS}
            inputValue={prefs.fontFamily}
            onInputChange={(_e, value) => prefs.set({ fontFamily: value })}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Font family"
                helperText="JetBrains Mono ships with Muxus; other fonts must be installed on this machine."
              />
            )}
          />
          <Stack direction="row" spacing={3}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Font size — {prefs.monoFontSize}px
              </Typography>
              <Slider
                size="small"
                min={8}
                max={24}
                value={prefs.monoFontSize}
                onChange={(_e, v) => prefs.set({ monoFontSize: v as number })}
              />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Line height — {prefs.lineHeight.toFixed(2)}
              </Typography>
              <Slider
                size="small"
                min={1}
                max={1.6}
                step={0.05}
                value={prefs.lineHeight}
                onChange={(_e, v) => prefs.set({ lineHeight: v as number })}
              />
            </Box>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}

/** Mini terminal preview: background swatch + the 8 ANSI hues + name. */
function SchemeCard({ scheme, selected, onSelect }: { scheme: TerminalScheme; selected: boolean; onSelect: () => void }) {
  const t = scheme.theme;
  const dots = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white, t.brightBlack];
  return (
    <ButtonBase
      aria-label={`Use ${scheme.name} color scheme`}
      onClick={onSelect}
      sx={{
        display: 'block',
        textAlign: 'left',
        borderRadius: 1,
        border: 2,
        borderColor: selected ? 'primary.main' : 'divider',
        overflow: 'hidden',
        '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' },
      }}
    >
      <Box sx={{ bgcolor: t.background, px: 1, py: 0.75 }}>
        <Typography sx={{ color: t.foreground, fontFamily: '"JetBrains Mono", monospace', fontSize: 11, lineHeight: 1.4 }}>
          $ muxus ▮
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
          {dots.map((color, i) => (
            <Box key={i} sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
          ))}
        </Stack>
      </Box>
      <Typography variant="caption" sx={{ display: 'block', px: 1, py: 0.4, fontWeight: selected ? 700 : 500 }}>
        {scheme.name}
      </Typography>
    </ButtonBase>
  );
}

function TerminalSection() {
  const prefs = usePrefsStore();

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Cursor</SectionTitle>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={prefs.cursorStyle}
            onChange={(_e, v: 'block' | 'underline' | 'bar' | null) => {
              if (v) prefs.set({ cursorStyle: v });
            }}
          >
            <ToggleButton value="block" sx={{ px: 2, fontFamily: 'monospace' }}>
              ▉ Block
            </ToggleButton>
            <ToggleButton value="underline" sx={{ px: 2, fontFamily: 'monospace' }}>
              ▁ Underline
            </ToggleButton>
            <ToggleButton value="bar" sx={{ px: 2, fontFamily: 'monospace' }}>
              ▏ Bar
            </ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            control={<Switch size="small" checked={prefs.cursorBlink} onChange={(e) => prefs.set({ cursorBlink: e.target.checked })} />}
            label={<Typography variant="body2">Blink</Typography>}
          />
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Clipboard & mouse</SectionTitle>
        <Stack spacing={1.5}>
          <TextField
            select
            label="Right-click"
            value={prefs.rightClickAction}
            onChange={(e) => prefs.set({ rightClickAction: e.target.value as RightClickAction })}
            sx={{ maxWidth: 420 }}
          >
            <MenuItem value="copy-paste">Copy selection, otherwise paste (terminal convention)</MenuItem>
            <MenuItem value="paste">Always paste</MenuItem>
            <MenuItem value="menu">Show context menu</MenuItem>
          </TextField>
          <FormControlLabel
            control={<Switch size="small" checked={prefs.copyOnSelect} onChange={(e) => prefs.set({ copyOnSelect: e.target.checked })} />}
            label={<Typography variant="body2">Copy on select</Typography>}
          />
          <FormControlLabel
            control={<Switch size="small" checked={prefs.pasteWarnMultiline} onChange={(e) => prefs.set({ pasteWarnMultiline: e.target.checked })} />}
            label={
              <Box>
                <Typography variant="body2">Confirm multiline pastes</Typography>
                <Typography variant="caption" color="text.secondary">
                  Preview before pasted text can run several shell commands.
                </Typography>
              </Box>
            }
          />
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Buffer</SectionTitle>
        <TextField
          label="Scrollback lines"
          type="number"
          value={prefs.scrollback}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= 0 && v <= 1_000_000) prefs.set({ scrollback: v });
          }}
          sx={{ width: 200 }}
        />
      </Box>
    </Stack>
  );
}

function BehaviorSection() {
  const prefs = usePrefsStore();
  const { data: info } = useAppInfo();

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Local terminal</SectionTitle>
        <TextField
          label="Shell"
          value={prefs.localShell}
          onChange={(e) => prefs.set({ localShell: e.target.value })}
          placeholder="auto"
          helperText={info ? `auto = ${info.defaultShell}` : 'auto = your login shell'}
          sx={{ maxWidth: 420 }}
          fullWidth
        />
      </Box>
      <Box>
        <SectionTitle>Tabs</SectionTitle>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={prefs.confirmCloseConnected}
              onChange={(e) => prefs.set({ confirmCloseConnected: e.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Confirm before closing a live session</Typography>
              <Typography variant="caption" color="text.secondary">
                Closing a connected tab ends its shell.
              </Typography>
            </Box>
          }
        />
      </Box>
    </Stack>
  );
}

function AboutSection() {
  const { data: info } = useAppInfo();
  return (
    <Stack spacing={1}>
      <SectionTitle>About</SectionTitle>
      <Typography variant="body2">
        Muxus {info?.version ?? ''} · {String(info?.platform ?? '')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Free, open-source SSH client & terminal — kitty graphics, split-pane workspaces, SFTP and
        terminal-independent port forwarding.
      </Typography>
    </Stack>
  );
}
