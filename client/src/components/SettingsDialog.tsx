import { useEffect, useMemo, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import type { UpdateCheckResult } from '@muxus/shared';
import { checkForUpdate } from '../api/app.js';
import { fetchAppLogs, formatLogEntry } from '../api/logs.js';
import {
  useSaveSessionHistorySettings,
  useSaveSessionLoggingPolicy,
} from '../api/session-history.js';
import {
  useAppInfo,
  useSessionHistoryStorage,
  useSessionLoggingPolicy,
} from '../api/queries.js';
import {
  FALLBACK_SESSION_LOGGING_POLICY,
  hostSessionLoggingDraft,
  sessionLoggingPolicyInput,
  type HostSessionLoggingDraft,
} from '../session-logging-policy.js';
import {
  INTERFACE_ZOOM_STEPS,
  clampInterfaceZoom,
  interfaceZoomLabel,
} from '../interface-zoom.js';
import { useChordLabel } from '../keymap/hints.js';
import { IS_MAC } from '../platform.js';
import {
  MAX_INACTIVE_PANE_DIM_STRENGTH,
  MIN_INACTIVE_PANE_DIM_STRENGTH,
  clampInactivePaneDimStrength,
  terminalSchemeIdForMode,
  usePrefsStore,
  type RightClickAction,
  type TabNumberVisibility,
  type TerminalFileLinkActivation,
  type ThemeMode,
} from '../state/prefs.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { confirmAction } from '../state/dialogs.js';
import { useUiStore } from '../state/ui.js';
import { terminalScheme } from '../terminal/palette.js';
import {
  terminalFileLinkActivationForPlatform,
  terminalFileLinkActivationOptions,
} from '../terminal/file-link-activation.js';
import {
  readInstalledTerminalFontFamilies,
  terminalFontFamilies,
  terminalFontIsAvailable,
} from '../terminal/font-catalog.js';
import { chordSx } from './chord-style.js';
import { HighlightProfilesSection } from './HighlightProfilesSection.js';
import { LocalShellProfilesSection } from './LocalShellProfilesSection.js';
import { SessionLoggingPolicyFields } from './SessionLoggingPolicyFields.js';
import { TerminalSchemeSelect } from './TerminalSchemeSelect.js';
import { DataTransferSection } from './DataTransferSection.js';
import { MobaXtermImportDialog } from './MobaXtermImportDialog.js';
import { PasswordVaultSection } from './PasswordVaultSection.js';
import { SecureCrtImportDialog } from './SecureCrtImportDialog.js';

type Section =
  | 'appearance'
  | 'terminal'
  | 'local-shells'
  | 'logging'
  | 'highlighting'
  | 'behavior'
  | 'keyboard'
  | 'passwords'
  | 'data'
  | 'debug'
  | 'about';

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'appearance', label: 'Appearance', icon: <PaletteOutlinedIcon fontSize="small" /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon fontSize="small" /> },
  { id: 'local-shells', label: 'Local shells', icon: <CodeOutlinedIcon fontSize="small" /> },
  { id: 'logging', label: 'Session logging', icon: <HistoryOutlinedIcon fontSize="small" /> },
  { id: 'highlighting', label: 'Highlighting', icon: <HighlightOutlinedIcon fontSize="small" /> },
  { id: 'behavior', label: 'Behavior', icon: <TuneOutlinedIcon fontSize="small" /> },
  { id: 'keyboard', label: 'Keyboard', icon: <KeyboardOutlinedIcon fontSize="small" /> },
  { id: 'passwords', label: 'Passwords', icon: <PasswordOutlinedIcon fontSize="small" /> },
  { id: 'data', label: 'Backup & data', icon: <BackupOutlinedIcon fontSize="small" /> },
  { id: 'debug', label: 'Debug', icon: <BugReportOutlinedIcon fontSize="small" /> },
  { id: 'about', label: 'About', icon: <InfoOutlinedIcon fontSize="small" /> },
];

const TERMINAL_FILE_LINK_ACTIVATION_OPTIONS = terminalFileLinkActivationOptions(IS_MAC);

/**
 * All preferences, applied live — including already-open terminals. The one
 * exception is session logging, whose policies are server-side and commit on
 * an explicit Save; that section reports back when it holds unsaved edits so
 * leaving it cannot throw them away silently.
 */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [section, setSection] = useState<Section>('appearance');
  const [loggingDirty, setLoggingDirty] = useState(false);
  const [sessionImportOpen, setSessionImportOpen] = useState<'mobaxterm' | 'securecrt' | null>(null);

  /** Nothing leaves the logging section behind without the user's say-so. */
  const leaveSection = (run: () => void) => {
    if (!loggingDirty || section !== 'logging') {
      run();
      return;
    }
    void confirmAction({
      title: 'Discard unsaved logging settings?',
      description:
        'Session logging changes are not applied until you save them. Leaving now loses your edits.',
      confirmLabel: 'Discard changes',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      setLoggingDirty(false);
      run();
    });
  };

  if (sessionImportOpen === 'mobaxterm') {
    return <MobaXtermImportDialog onClose={() => setSessionImportOpen(null)} />;
  }
  if (sessionImportOpen === 'securecrt') {
    return <SecureCrtImportDialog onClose={() => setSessionImportOpen(null)} />;
  }

  return (
    <Dialog
      open={open}
      onClose={() => leaveSection(() => setOpen(false))}
      maxWidth="md"
      fullWidth
      aria-labelledby="settings-dialog-title"
    >
      <Box sx={{ display: 'flex', height: 620, maxHeight: '82vh' }}>
        <List sx={{ width: 192, flexShrink: 0, borderRight: 1, borderColor: 'divider', py: 1 }}>
          <Typography id="settings-dialog-title" variant="h6" sx={{ px: 2, py: 1, fontWeight: 700 }}>
            Settings
          </Typography>
          {SECTIONS.map((s) => (
            <ListItemButton
              key={s.id}
              selected={section === s.id}
              onClick={() => leaveSection(() => setSection(s.id))}
              sx={{ borderRadius: 1, mx: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>{s.icon}</ListItemIcon>
              <ListItemText primary={s.label} slotProps={{ primary: { variant: 'body2' } }} />
              {s.id === 'logging' && loggingDirty ? (
                <Tooltip title="Unsaved changes">
                  <Box
                    aria-label="Unsaved changes"
                    sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }}
                  />
                </Tooltip>
              ) : null}
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, overflowY: 'auto', p: 3, pt: 2.5 }}>
            {section === 'appearance' && <AppearanceSection />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'local-shells' && <LocalShellProfilesSection />}
            {section === 'logging' && <SessionLoggingSection onDirtyChange={setLoggingDirty} />}
            {section === 'highlighting' && <HighlightProfilesSection />}
            {section === 'behavior' && <BehaviorSection />}
            {section === 'keyboard' && <KeyboardSection />}
            {section === 'passwords' && <PasswordVaultSection />}
            {section === 'data' && (
              <DataTransferSection
                onImportMobaXterm={() => setSessionImportOpen('mobaxterm')}
                onImportSecureCrt={() => setSessionImportOpen('securecrt')}
              />
            )}
            {section === 'debug' && <DebugSection />}
            {section === 'about' && <AboutSection />}
          </Box>
          <DialogActions sx={{ borderTop: 1, borderColor: 'divider' }}>
            <Typography
              variant="caption"
              color={loggingDirty && section === 'logging' ? 'warning.main' : 'text.secondary'}
              sx={{ flex: 1, pl: 1 }}
            >
              {loggingDirty && section === 'logging'
                ? 'Unsaved changes — use the Save buttons in this section to apply them.'
                : section === 'data'
                  ? 'Backups never include passwords, private key files or session recordings.'
                  : 'Everything here applies immediately, except session logging, which saves explicitly.'}
            </Typography>
            <Button variant="contained" onClick={() => leaveSection(() => setOpen(false))}>
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
  const effectiveThemeMode = useTheme().palette.mode;
  const [installedFontFamilies, setInstalledFontFamilies] = useState<readonly string[]>();
  const [fontCatalogLoading, setFontCatalogLoading] = useState(
    () => window.muxusDesktop?.listLocalFontFamilies !== undefined,
  );
  useEffect(() => {
    let active = true;
    void readInstalledTerminalFontFamilies()
      .then((families) => {
        if (active) setInstalledFontFamilies(families);
      })
      .finally(() => {
        if (active) setFontCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const fontFamilies = useMemo(
    () => terminalFontFamilies(installedFontFamilies),
    [installedFontFamilies],
  );
  const selectedFontAvailable = terminalFontIsAvailable(
    prefs.fontFamily,
    installedFontFamilies,
  );
  const zoomInChord = useChordLabel('terminal.zoom-in');
  const zoomOutChord = useChordLabel('terminal.zoom-out');
  const schemeTheme = terminalScheme(
    terminalSchemeIdForMode(prefs, effectiveThemeMode),
  ).theme;
  const schemeForeground = schemeTheme.foreground ?? '#cccccc';
  const schemeBackground = schemeTheme.background ?? '#1e1e1e';

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
          <ToggleButton value="os" sx={{ px: 2 }}>
            System
          </ToggleButton>
          <ToggleButton value="dark" sx={{ px: 2 }}>
            Dark
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box>
        <SectionTitle>Interface scale</SectionTitle>
        <FormControl sx={{ width: 200 }}>
          <InputLabel id="interface-zoom-label">Scale</InputLabel>
          <Select
            labelId="interface-zoom-label"
            value={String(clampInterfaceZoom(prefs.interfaceZoom))}
            label="Scale"
            onChange={(event) => prefs.set({ interfaceZoom: Number(event.target.value) })}
          >
            {INTERFACE_ZOOM_STEPS.map((step) => (
              <MenuItem key={step} value={String(step)}>
                {interfaceZoomLabel(step)}
                {step === 1 ? ' (default)' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Scales the whole window. Terminal text has its own zoom
          {zoomInChord && zoomOutChord ? ` (${zoomInChord} / ${zoomOutChord} or Ctrl+scroll)` : ' (Ctrl+scroll)'},
          which this does not touch.
        </Typography>
      </Box>
      <Box>
        <SectionTitle>Terminal color schemes</SectionTitle>
        <Stack spacing={2} sx={{ width: '100%', maxWidth: 420 }}>
          <TerminalSchemeSelect
            id="light-terminal-theme"
            label="Light terminal theme"
            value={prefs.lightTerminalScheme}
            onChange={(lightTerminalScheme) => prefs.set({ lightTerminalScheme })}
          />
          <TerminalSchemeSelect
            id="dark-terminal-theme"
            label="Dark terminal theme"
            value={prefs.darkTerminalScheme}
            onChange={(darkTerminalScheme) => prefs.set({ darkTerminalScheme })}
          />
        </Stack>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mt: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Background color
          </Typography>
          <Box
            component="input"
            type="color"
            aria-label="Background color"
            value={prefs.backgroundColor || schemeBackground}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              prefs.set({ backgroundColor: event.target.value })
            }
            sx={{
              width: 30,
              height: 26,
              p: 0.25,
              border: 1,
              borderColor: 'divider',
              borderRadius: 0.75,
              bgcolor: 'transparent',
              cursor: 'pointer',
            }}
          />
          {prefs.backgroundColor ? (
            <Button size="small" onClick={() => prefs.set({ backgroundColor: '' })}>
              Use scheme color
            </Button>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Following the color scheme
            </Typography>
          )}
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Split pane focus</SectionTitle>
        <Stack spacing={1.25} sx={{ maxWidth: 440 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.dimInactivePanes}
                onChange={(event) => prefs.set({ dimInactivePanes: event.target.checked })}
              />
            }
            label={<Typography variant="body2">Dim inactive panes</Typography>}
          />
          <Box sx={{ pl: 4.5, maxWidth: 360 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Dimming strength —{' '}
              {Math.round(
                clampInactivePaneDimStrength(prefs.inactivePaneDimStrength) * 100,
              )}
              %
            </Typography>
            <Slider
              aria-label="Inactive pane dimming strength"
              size="small"
              min={MIN_INACTIVE_PANE_DIM_STRENGTH * 100}
              max={MAX_INACTIVE_PANE_DIM_STRENGTH * 100}
              step={5}
              value={clampInactivePaneDimStrength(prefs.inactivePaneDimStrength) * 100}
              disabled={!prefs.dimInactivePanes}
              onChange={(_event, value) =>
                prefs.set({ inactivePaneDimStrength: (value as number) / 100 })
              }
            />
          </Box>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.activePaneBorder}
                onChange={(event) => prefs.set({ activePaneBorder: event.target.checked })}
              />
            }
            label={<Typography variant="body2">Show a thin accent outline</Typography>}
          />
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Font</SectionTitle>
        <Stack spacing={2}>
          <Autocomplete
            freeSolo
            loading={fontCatalogLoading}
            options={fontFamilies}
            inputValue={prefs.fontFamily}
            onInputChange={(_e, value) => prefs.set({ fontFamily: value })}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Font family"
                error={!fontCatalogLoading && selectedFontAvailable === false}
                helperText={
                  fontCatalogLoading
                    ? 'Reading installed fonts…'
                    : selectedFontAvailable === false
                      ? `${prefs.fontFamily.trim() || 'This font'} is not installed; JetBrains Mono is being used as the fallback.`
                      : installedFontFamilies
                        ? 'JetBrains Mono is bundled; the other choices are installed on this machine.'
                        : 'JetBrains Mono is bundled; custom font names use the system installation when available.'
                }
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
          <Box>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Font color
              </Typography>
              <Box
                component="input"
                type="color"
                aria-label="Font color"
                value={prefs.fontColor || schemeForeground}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  prefs.set({ fontColor: event.target.value })
                }
                sx={{
                  width: 30,
                  height: 26,
                  p: 0.25,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 0.75,
                  bgcolor: 'transparent',
                  cursor: 'pointer',
                }}
              />
              {prefs.fontColor ? (
                <Button size="small" onClick={() => prefs.set({ fontColor: '' })}>
                  Use scheme color
                </Button>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Following the color scheme
                </Typography>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Replaces the scheme's default text color. Output that picks its own
              ANSI colors keeps the scheme palette.
            </Typography>
          </Box>
        </Stack>
      </Box>
    </Stack>
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
          <TextField
            select
            label="Open terminal links"
            value={terminalFileLinkActivationForPlatform(
              prefs.terminalFileLinkActivation,
              IS_MAC,
            )}
            onChange={(e) =>
              prefs.set({
                terminalFileLinkActivation: e.target.value as TerminalFileLinkActivation,
              })
            }
            sx={{ maxWidth: 420 }}
          >
            {TERMINAL_FILE_LINK_ACTIVATION_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={<Switch size="small" checked={prefs.copyOnSelect} onChange={(e) => prefs.set({ copyOnSelect: e.target.checked })} />}
            label={<Typography variant="body2">Copy on select</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.allowOsc52ClipboardWrite}
                onChange={(e) => prefs.set({ allowOsc52ClipboardWrite: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Allow terminal clipboard writes (OSC 52)</Typography>
                <Typography variant="caption" color="text.secondary">
                  Lets terminal programs such as tmux and Zellij replace the system clipboard. Clipboard reads remain blocked.
                </Typography>
              </Box>
            }
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
      <Box>
        <SectionTitle>Renderer</SectionTitle>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={prefs.webglRenderer}
              onChange={(e) => prefs.set({ webglRenderer: e.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">GPU renderer (WebGL)</Typography>
              <Typography variant="caption" color="text.secondary">
                Paints terminals on the GPU instead of the DOM — smoother under
                heavy output, slightly more CPU while idle. Applies to open
                terminals immediately.
              </Typography>
            </Box>
          }
        />
      </Box>
    </Stack>
  );
}

function BehaviorSection() {
  const prefs = usePrefsStore();

  return (
    <Stack spacing={3}>
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
      <Box>
        <SectionTitle>Restore & reconnect</SectionTitle>
        <Stack spacing={1.5}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.autoReconnectRemote}
                onChange={(e) => prefs.set({ autoReconnectRemote: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Automatically reconnect remote sessions</Typography>
                <Typography variant="caption" color="text.secondary">
                  Restoring a workspace dials its SSH, Telnet and serial tabs, and a dropped
                  connection redials a few times before waiting for a key press. Off: remote
                  tabs wait until asked.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.restoreScrollback}
                onChange={(e) => prefs.set({ restoreScrollback: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Restore terminal history</Typography>
                <Typography variant="caption" color="text.secondary">
                  Recent output is saved locally every few seconds and shown again above the
                  new session after a restore or reconnect.
                </Typography>
              </Box>
            }
          />
        </Stack>
      </Box>
    </Stack>
  );
}

/** Split behavior plus the entry point to the full shortcut editor. */
function KeyboardSection() {
  const splitInheritsSession = usePrefsStore((s) => s.splitInheritsSession);
  const tabNumberVisibility = usePrefsStore((s) => s.tabNumberVisibility);
  const set = usePrefsStore((s) => s.set);
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const keybindings = usePrefsStore((s) => s.keybindings);
  const customCount = Object.keys(keybindings).length;
  const splitChord = useChordLabel('pane.split.right');
  const focusChord = useChordLabel('pane.focus.right');
  const numberedTabChord = useChordLabel('tab.select.1');
  const moveChord = useChordLabel('tab.to-pane.right');
  const zoomChord = useChordLabel('pane.zoom');

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Splitting</SectionTitle>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={splitInheritsSession}
              onChange={(e) => set({ splitInheritsSession: e.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">New splits continue the current session</Typography>
              <Typography variant="caption" color="text.secondary">
                Splitting opens a second session on the same host (SSH reuses the live
                connection). Off: the new pane asks what to start. Serial consoles always ask.
              </Typography>
            </Box>
          }
        />
      </Box>
      <Box>
        <SectionTitle>Tab numbers</SectionTitle>
        <TextField
          select
          size="small"
          label="Show tab numbers"
          value={tabNumberVisibility}
          onChange={(event) =>
            set({ tabNumberVisibility: event.target.value as TabNumberVisibility })
          }
          sx={{ width: 320, maxWidth: '100%' }}
        >
          <MenuItem value="shortcut">While Alt is held</MenuItem>
          <MenuItem value="always">Always</MenuItem>
        </TextField>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Tabs are numbered across the whole window and update when tabs or panes move.
        </Typography>
      </Box>
      <Box>
        <SectionTitle>Layout keys</SectionTitle>
        <Stack spacing={0.75} sx={{ mb: 2 }}>
          <KeyboardSummaryRow label="Split the focused pane in any direction" chord={splitChord} />
          <KeyboardSummaryRow label="Move focus between panes" chord={focusChord} />
          <KeyboardSummaryRow label="Jump to a window-wide numbered tab" chord={numberedTabChord} />
          <KeyboardSummaryRow label="Send the current tab to another pane" chord={moveChord} />
          <KeyboardSummaryRow label="Zoom a pane / restore the layout" chord={zoomChord} />
        </Stack>
        <Button
          variant="outlined"
          size="small"
          startIcon={<KeyboardOutlinedIcon />}
          onClick={() => setShortcutsOpen(true)}
        >
          All shortcuts{customCount > 0 ? ` · ${customCount} customized` : ''}
        </Button>
      </Box>
    </Stack>
  );
}

function KeyboardSummaryRow({ label, chord }: { label: string; chord?: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={chordSx()}>
        {chord ?? 'Unbound'}
      </Typography>
    </Stack>
  );
}

function SessionLoggingSection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { data: policy, isLoading } = useSessionLoggingPolicy('*');
  const {
    data: localPolicy,
    isLoading: localPolicyLoading,
  } = useSessionLoggingPolicy('local');
  const [draft, setDraft] = useState<HostSessionLoggingDraft>({
    ...FALLBACK_SESSION_LOGGING_POLICY,
    inherit: false,
    loaded: false,
  });
  const [localDraft, setLocalDraft] = useState<HostSessionLoggingDraft>({
    ...FALLBACK_SESSION_LOGGING_POLICY,
    inherit: true,
    loaded: false,
  });
  // Refs keep a refetch from clobbering edits in progress; the mirrored state
  // is what the rail's unsaved marker reads.
  const defaultDirty = useRef(false);
  const localDirty = useRef(false);
  const [defaultEdited, setDefaultEdited] = useState(false);
  const [localEdited, setLocalEdited] = useState(false);
  const [historyEdited, setHistoryEdited] = useState(false);
  const savePolicy = useSaveSessionLoggingPolicy(() => {
    defaultDirty.current = false;
    setDefaultEdited(false);
    showToast('success', 'Default session logging settings saved.');
  });
  const saveLocalPolicy = useSaveSessionLoggingPolicy(() => {
    localDirty.current = false;
    setLocalEdited(false);
    showToast('success', 'Local terminal logging settings saved.');
  });

  useEffect(() => {
    onDirtyChange(defaultEdited || localEdited || historyEdited);
  }, [defaultEdited, localEdited, historyEdited, onDirtyChange]);

  useEffect(() => {
    if (!policy || defaultDirty.current) return;
    setDraft(hostSessionLoggingDraft(policy, false));
  }, [policy]);

  useEffect(() => {
    if (!localPolicy || localDirty.current) return;
    setLocalDraft(
      hostSessionLoggingDraft(localPolicy, !localPolicy.overridden),
    );
  }, [localPolicy]);

  const set = (patch: Partial<HostSessionLoggingDraft>) => {
    defaultDirty.current = true;
    setDefaultEdited(true);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setLocal = (patch: Partial<HostSessionLoggingDraft>) => {
    localDirty.current = true;
    setLocalEdited(true);
    setLocalDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Default session logging</SectionTitle>
        <Typography variant="body2" color="text.secondary">
          Logging is off by default. These settings are inherited by hosts without their own
          override and affect newly opened sessions.
        </Typography>
      </Box>
      <SessionLoggingPolicyFields value={draft} onChange={set} />
      <Box>
        <Button
          variant="contained"
          disabled={isLoading || !draft.loaded || !defaultEdited || savePolicy.isPending}
          onClick={() =>
            savePolicy.mutate({
              profileKey: '*',
              policy: sessionLoggingPolicyInput(draft),
            })
          }
        >
          Save logging settings
        </Button>
      </Box>
      <Divider />
      <Box>
        <SectionTitle>Local terminals</SectionTitle>
        <Typography variant="body2" color="text.secondary">
          Local shells have no host entry, so their optional override is configured here.
          It applies to newly opened local terminals.
        </Typography>
      </Box>
      <SessionLoggingPolicyFields
        value={localDraft}
        onChange={setLocal}
        allowInherit
      />
      <Box>
        <Button
          variant="contained"
          disabled={
            localPolicyLoading ||
            !localDraft.loaded ||
            !localEdited ||
            saveLocalPolicy.isPending
          }
          onClick={() =>
            saveLocalPolicy.mutate({
              profileKey: 'local',
              policy: localDraft.inherit
                ? null
                : sessionLoggingPolicyInput(localDraft),
            })
          }
        >
          Save local terminal settings
        </Button>
      </Box>
      <Divider />
      <HistoryStorageSettings onDirtyChange={setHistoryEdited} />
    </Stack>
  );
}

interface HistoryStorageDraft {
  storageLocation: string;
  maxTotalGiB: string;
  minFreeGiB: string;
  minFreePercent: string;
  maxAgeDays: string;
}

const EMPTY_HISTORY_STORAGE_DRAFT: HistoryStorageDraft = {
  storageLocation: '',
  maxTotalGiB: '5',
  minFreeGiB: '2',
  minFreePercent: '5',
  maxAgeDays: '',
};

function HistoryStorageSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { data: status, isLoading } = useSessionHistoryStorage();
  const [draft, setDraft] = useState<HistoryStorageDraft>(
    EMPTY_HISTORY_STORAGE_DRAFT,
  );
  const dirty = useRef(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => onDirtyChange(edited), [edited, onDirtyChange]);
  const save = useSaveSessionHistorySettings((next) => {
    dirty.current = false;
    setEdited(false);
    showToast(
      'success',
      next.restartRequired
        ? 'History limits saved. Restart Muxus to use the new location.'
        : 'History storage limits saved.',
    );
  });

  useEffect(() => {
    if (!status || dirty.current) return;
    setDraft({
      storageLocation: status.settings.storageLocation ?? '',
      maxTotalGiB: bytesToGiB(status.settings.maxTotalBytes),
      minFreeGiB: bytesToGiB(status.settings.minFreeBytes),
      minFreePercent: String(status.settings.minFreePercent),
      maxAgeDays: status.settings.maxAgeDays
        ? String(status.settings.maxAgeDays)
        : '',
    });
  }, [status]);

  const set = (patch: Partial<HistoryStorageDraft>) => {
    dirty.current = true;
    setEdited(true);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const maxTotalBytes = gibToBytes(draft.maxTotalGiB);
  const minFreeBytes = gibToBytes(draft.minFreeGiB);
  const minFreePercent = Number(draft.minFreePercent);
  const maxAgeDays = draft.maxAgeDays ? Number(draft.maxAgeDays) : undefined;
  const valid =
    maxTotalBytes >= 64 * 1024 * 1024 &&
    minFreeBytes >= 0 &&
    minFreePercent >= 0 &&
    minFreePercent <= 100 &&
    (maxAgeDays === undefined ||
      (Number.isInteger(maxAgeDays) && maxAgeDays >= 1));

  return (
    <Stack spacing={2}>
      <Box>
        <SectionTitle>History storage and retention</SectionTitle>
        <Typography variant="body2" color="text.secondary">
          The hard quota measures compressed segments, the search database,
          and its WAL. Cleanup removes the oldest unpinned completed sessions
          down to about 85% of the limit.
        </Typography>
      </Box>
      {status?.warning ? <Alert severity="warning">{status.warning}</Alert> : null}
      <Typography variant="body2" color="text.secondary">
        {status
          ? `${formatStorageBytes(status.usageBytes)} used · ${formatStorageBytes(status.freeBytes)} free · active at ${status.activeStorageLocation}`
          : 'Loading current history usage…'}
      </Typography>
      <TextField
        label="History location"
        value={draft.storageLocation}
        onChange={(event) => set({ storageLocation: event.target.value })}
        helperText="Leave blank for the platform default. Changes take effect after restart; existing history is left at its old location."
        placeholder={status?.activeStorageLocation}
        fullWidth
      />
      <Stack direction="row" spacing={2}>
        <TextField
          label="Maximum history (GiB)"
          type="number"
          value={draft.maxTotalGiB}
          onChange={(event) => set({ maxTotalGiB: event.target.value })}
          slotProps={{ htmlInput: { min: 0.0625, step: 0.25 } }}
          fullWidth
        />
        <TextField
          label="Minimum free (GiB)"
          type="number"
          value={draft.minFreeGiB}
          onChange={(event) => set({ minFreeGiB: event.target.value })}
          slotProps={{ htmlInput: { min: 0, step: 0.25 } }}
          fullWidth
        />
        <TextField
          label="Minimum free (%)"
          type="number"
          value={draft.minFreePercent}
          onChange={(event) => set({ minFreePercent: event.target.value })}
          slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
          fullWidth
        />
      </Stack>
      <TextField
        label="Maximum age (days)"
        type="number"
        value={draft.maxAgeDays}
        onChange={(event) => set({ maxAgeDays: event.target.value })}
        helperText="Optional. Blank keeps sessions indefinitely, subject to size and free-space limits."
        slotProps={{ htmlInput: { min: 1, step: 1 } }}
        sx={{ maxWidth: 260 }}
      />
      <Box>
        <Button
          variant="contained"
          disabled={isLoading || !valid || !edited || save.isPending}
          onClick={() =>
            save.mutate({
              storageLocation: draft.storageLocation.trim() || undefined,
              maxTotalBytes,
              minFreeBytes,
              minFreePercent,
              maxAgeDays,
            })
          }
        >
          Save history storage
        </Button>
      </Box>
    </Stack>
  );
}

function updateReasonLabel(reason?: string): string {
  switch (reason) {
    case 'timeout':
      return 'The update check timed out.';
    case 'network':
      return 'The update check could not reach GitHub.';
    case 'no-release':
      return 'No published release was found.';
    case 'missing-version':
    case 'missing-release-url':
      return 'The latest release metadata is incomplete.';
    default:
      return reason?.startsWith('manifest-')
        ? `The update manifest returned ${reason.replace('manifest-', '')}.`
        : 'The update check could not be completed.';
  }
}

/** Diagnostic logging: the verbose-capture toggle plus log viewer and export. */
function DebugSection() {
  const debugMode = usePrefsStore((s) => s.debugMode);
  const set = usePrefsStore((s) => s.set);
  const setLogViewerOpen = useUiStore((s) => s.setLogViewerOpen);

  const exportLogs = () => {
    fetchAppLogs()
      .then((logs) => {
        saveTextFile(
          exportFilename('debug log', 'log'),
          [
            `# Muxus diagnostic log — exported ${new Date().toISOString()}`,
            `# ${logs.entries.length} entries, debug logging ${logs.debugEnabled ? 'on' : 'off'}`,
            ...logs.entries.map(formatLogEntry),
          ].join('\n'),
        );
      })
      .catch(showErrorToast);
  };

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>Debug mode</SectionTitle>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={debugMode}
              onChange={(e) => set({ debugMode: e.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Capture verbose diagnostic logs</Typography>
              <Typography variant="caption" color="text.secondary">
                Records connection-level detail: every dial, authentication step,
                SSH agent wait and the raw error behind a failure. Warnings and
                errors are always captured, even while this is off.
              </Typography>
            </Box>
          }
        />
      </Box>
      <Box>
        <SectionTitle>Logs</SectionTitle>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<ArticleOutlinedIcon />}
            onClick={() => setLogViewerOpen(true)}
          >
            View logs
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            onClick={exportLogs}
          >
            Export logs
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Covers app startup and every connection attempt since launch. Logs are
          held in memory on this machine only and never leave it unless you export
          them. If the app fails to launch entirely, the desktop shell also writes
          logs/main.log in its data directory.
        </Typography>
      </Box>
    </Stack>
  );
}

function AboutSection() {
  const { data: info } = useAppInfo();
  const prefs = usePrefsStore();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const checkForUpdates = () => {
    setChecking(true);
    setResult(null);
    void checkForUpdate({ force: true })
      .then(setResult)
      .catch(() => setResult({ available: false, currentVersion: info?.version ?? '', reason: 'network' }))
      .finally(() => setChecking(false));
  };

  const updatesAvailable = result?.available === true;

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>About</SectionTitle>
        <Stack spacing={1.25}>
          <Typography variant="body2">
            Muxus {info?.version ?? ''} · {String(info?.platform ?? '')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Free, open-source SSH, Telnet, and serial client — kitty graphics, split-pane
            workspaces, SFTP and terminal-independent port forwarding.
          </Typography>
          <Link href="https://github.com/FloSch62/muxus" target="_blank" rel="noreferrer">
            github.com/FloSch62/muxus
          </Link>
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Updates</SectionTitle>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefs.notifyOnNewVersion}
                onChange={(e) => prefs.set({ notifyOnNewVersion: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Notify me when a new version is available</Typography>
                <Typography variant="caption" color="text.secondary">
                  Off: no notification at startup — checking here still works.
                </Typography>
              </Box>
            }
          />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button
              variant="contained"
              startIcon={checking ? <CircularProgress color="inherit" size={16} /> : <CachedOutlinedIcon />}
              disabled={checking}
              onClick={checkForUpdates}
            >
              Check for updates
            </Button>
            {updatesAvailable ? (
              <Button startIcon={<DownloadOutlinedIcon />} href={result.releaseUrl} target="_blank" rel="noreferrer">
                Download
              </Button>
            ) : null}
          </Stack>
          {result?.available === false && result.latestVersion ? (
            <Alert severity="success" variant="outlined">
              Muxus is up to date. Latest release: {result.latestVersion}.
            </Alert>
          ) : null}
          {result?.available === false && !result.latestVersion ? (
            <Alert severity="warning" variant="outlined">
              {updateReasonLabel(result.reason)}
            </Alert>
          ) : null}
          {updatesAvailable ? (
            <Alert severity="info" variant="outlined">
              Muxus {result.latestVersion} is available. You are running {result.currentVersion}.
            </Alert>
          ) : null}
        </Stack>
      </Box>
    </Stack>
  );
}

const GIB = 1024 ** 3;

function gibToBytes(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * GIB)
    : -1;
}

function bytesToGiB(value: number): string {
  return String(Number((value / GIB).toFixed(3)));
}

function formatStorageBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < GIB) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / GIB).toFixed(2)} GiB`;
}
