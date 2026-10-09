import { useCallback, useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import type { SvgIconComponent } from '@mui/icons-material';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CloseIcon from '@mui/icons-material/Close';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import VerticalSplitOutlinedIcon from '@mui/icons-material/VerticalSplitOutlined';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import {
  DEFAULT_SESSION_LOG_FILE_PATTERN,
  sessionLogFileName,
  sessionLogFilePatternError,
} from '@muxus/shared';
import { parsePasteDelay, PASTE_DELAY_MAX } from '../terminal/paste-pacing.js';
import { fetchAppLogs, formatLogEntry } from '../api/logs.js';
import {
  useSaveSessionHistorySettings,
  useSaveSessionLogFileSettings,
  useSaveSessionLoggingPolicy,
} from '../api/session-history.js';
import {
  useSessionHistoryStorage,
  useSessionLogFiles,
  useSessionLoggingPolicy,
} from '../api/queries.js';
import {
  FALLBACK_SESSION_LOGGING_POLICY,
  hostSessionLoggingDraft,
  sameSessionLoggingDraft,
  sessionLoggingPolicyInput,
} from '../session-logging-policy.js';
import { useSettingsDraft } from '../settings-draft.js';
import {
  STATUS_BAR_ITEM_LABELS,
  STATUS_BAR_ITEMS,
  withStatusBarItem,
} from '../host-stats.js';
import {
  INTERFACE_ZOOM_STEPS,
  clampInterfaceZoom,
  interfaceZoomLabel,
} from '../interface-zoom.js';
import { useChordLabel } from '../keymap/hints.js';
import { IS_MAC } from '../platform.js';
import {
  DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS,
  MAX_INACTIVE_PANE_DIM_STRENGTH,
  MIN_INACTIVE_PANE_DIM_STRENGTH,
  clampInactivePaneDimStrength,
  terminalSchemeIdForMode,
  useCustomTerminalSchemes,
  usePrefsStore,
  type CommandBarPosition,
  type FileBrowserPosition,
  type NewSshHostStorage,
  type RightClickAction,
  type SidebarOpenGesture,
  type SidebarPosition,
  type TabNumberVisibility,
  type TerminalFileLinkActivation,
  type ThemeMode,
} from '../state/prefs.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { confirmAction } from '../state/dialogs.js';
import { useUiStore, type SettingsSection, type SettingsTarget } from '../state/ui.js';
import { terminalScheme } from '../terminal/palette.js';
import { statusTextColor } from '../theme.js';
import {
  terminalFileLinkActivationForPlatform,
  terminalFileLinkActivationOptions,
} from '../terminal/file-link-activation.js';
import {
  readInstalledTerminalFontFamilies,
  terminalFontFamilies,
  terminalFontIsAvailable,
} from '../terminal/font-catalog.js';
import { AboutSection } from './AboutSection.js';
import { chordSx } from './chord-style.js';
import { CustomTerminalSchemeSettings } from './CustomTerminalSchemeSettings.js';
import { HighlightProfilesSection } from './HighlightProfilesSection.js';
import { LayoutPreview } from './LayoutPreview.js';
import { LinkHandlerSettings } from './LinkHandlerSettings.js';
import { LocalShellProfilesSection } from './LocalShellProfilesSection.js';
import { SessionLoggingPolicyFields } from './SessionLoggingPolicyFields.js';
import { RowSelect, SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';
import { TerminalSchemeSelect } from './TerminalSchemeSelect.js';
import { DataTransferSection } from './DataTransferSection.js';
import { MobaXtermImportDialog } from './MobaXtermImportDialog.js';
import { PasswordVaultSection } from './PasswordVaultSection.js';
import { X11Section } from './X11Section.js';
import { SecureCrtImportDialog } from './SecureCrtImportDialog.js';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: SvgIconComponent }> = [
  { id: 'appearance', label: 'Appearance', icon: PaletteOutlinedIcon },
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'local-shells', label: 'Local shells', icon: CodeOutlinedIcon },
  { id: 'logging', label: 'Session logging', icon: HistoryOutlinedIcon },
  { id: 'highlighting', label: 'Highlighting', icon: HighlightOutlinedIcon },
  { id: 'behavior', label: 'Behavior', icon: TuneOutlinedIcon },
  { id: 'x11', label: 'X11 forwarding', icon: DesktopWindowsOutlinedIcon },
  { id: 'keyboard', label: 'Keyboard', icon: KeyboardOutlinedIcon },
  { id: 'passwords', label: 'Passwords', icon: PasswordOutlinedIcon },
  { id: 'data', label: 'Backup & data', icon: BackupOutlinedIcon },
  { id: 'debug', label: 'Debug', icon: BugReportOutlinedIcon },
  { id: 'about', label: 'About', icon: InfoOutlinedIcon },
];

const TERMINAL_FILE_LINK_ACTIVATION_OPTIONS = terminalFileLinkActivationOptions(IS_MAC);

/** The selected section: a primary tint and primary text. No indicator bar, no weight jump. */
const NAV_TAB_SX = {
  minHeight: 34,
  py: 0.75,
  px: 1.25,
  mx: 1,
  my: 0.125,
  borderRadius: 1.5,
  justifyContent: 'flex-start',
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 500,
  gap: 1.25,
  color: 'text.secondary',
  '& .MuiTab-icon': { fontSize: 18, m: 0, color: 'text.secondary' },
  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
  '&.Mui-selected': {
    color: 'primary.main',
    bgcolor: (theme: Theme) =>
      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.09),
    '& .MuiTab-icon': { color: 'primary.main' },
  },
} as const;

/** Where the settings stand: the open section, the entry they were opened
 * for, and whether the logging section holds unsaved edits. */
export interface SettingsNavigation {
  section: SettingsSection;
  /** The entry settings were opened for, highlighted until another section is picked. */
  focusItem?: string;
  loggingDirty: boolean;
  setLoggingDirty: (dirty: boolean) => void;
  /** Run `action` unless that would silently drop unsaved logging edits. */
  leaveSection: (action: () => void) => void;
  pick: (section: SettingsSection) => void;
  /** Bring a section, and optionally one entry in it, into view. */
  show: (target: SettingsTarget) => void;
}

/**
 * All preferences apply live — including in already-open terminals. The one
 * exception is session logging, whose policies are server-side and commit on
 * an explicit Save; that section reports back when it holds unsaved edits so
 * leaving it cannot throw them away silently.
 */
export function useSettingsNavigation(initial?: SettingsTarget | null): SettingsNavigation {
  const [section, setSection] = useState<SettingsSection>(initial?.section ?? 'appearance');
  const [focusItem, setFocusItem] = useState(initial?.item);
  const [loggingDirty, setLoggingDirty] = useState(false);

  /** Nothing leaves the logging section behind without the user's say-so. */
  const leaveSection = useCallback(
    (run: () => void) => {
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
    },
    [loggingDirty, section],
  );
  const show = useCallback(
    (target: SettingsTarget) => {
      if (target.section === section) {
        setFocusItem(target.item);
        return;
      }
      leaveSection(() => {
        setSection(target.section);
        setFocusItem(target.item);
      });
    },
    [leaveSection, section],
  );
  const pick = useCallback(
    (next: SettingsSection) => {
      if (next !== section) show({ section: next });
    },
    [section, show],
  );
  return { section, focusItem, loggingDirty, setLoggingDirty, leaveSection, pick, show };
}

export type SessionImportSource = 'mobaxterm' | 'securecrt';

/** Bring sessions over from another client, in a dialog of its own. */
export function ClientSessionImportDialog({
  source,
  onClose,
}: {
  source: SessionImportSource;
  onClose: () => void;
}) {
  return source === 'mobaxterm' ? (
    <MobaXtermImportDialog onClose={onClose} />
  ) : (
    <SecureCrtImportDialog onClose={onClose} />
  );
}

/** The section list beside the open section; fills the dialog or window holding it. */
export function SettingsBody({
  navigation,
  onImport,
}: {
  navigation: SettingsNavigation;
  onImport: (source: SessionImportSource) => void;
}) {
  return (
    <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <Tabs
        orientation="vertical"
        value={navigation.section}
        onChange={(_event, next: SettingsSection) => navigation.pick(next)}
        aria-label="Settings sections"
        variant="scrollable"
        slotProps={{ indicator: { sx: { display: 'none' } } }}
        sx={{
          width: 196,
          flexShrink: 0,
          py: 1,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha('#000', 0.12)
              : alpha(theme.palette.text.primary, 0.02),
          display: { xs: 'none', sm: 'flex' },
        }}
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <Tab
            key={id}
            value={id}
            icon={<Icon />}
            iconPosition="start"
            sx={NAV_TAB_SX}
            label={
              id === 'logging' && navigation.loggingDirty ? (
                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  {label}
                  <Tooltip title="Unsaved changes">
                    <Box
                      component="span"
                      aria-label="Unsaved changes"
                      sx={{ ml: 'auto', width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }}
                    />
                  </Tooltip>
                </Box>
              ) : (
                label
              )
            }
          />
        ))}
      </Tabs>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflowY: 'auto',
          px: { xs: 2, sm: 3.5 },
          py: 3,
          bgcolor: 'background.default',
        }}
      >
        {/* Narrow windows: the section list becomes a picker above the page. */}
        <FormControl size="small" fullWidth sx={{ display: { xs: 'flex', sm: 'none' }, mb: 2.5 }}>
          <Select
            value={navigation.section}
            inputProps={{ 'aria-label': 'Settings section' }}
            onChange={(event) => navigation.pick(event.target.value as SettingsSection)}
          >
            {SECTIONS.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Box sx={{ maxWidth: 760 }}>
          {navigation.section === 'appearance' && <AppearanceSection />}
          {navigation.section === 'terminal' && <TerminalSection />}
          {navigation.section === 'local-shells' && (
            <LocalShellProfilesSection focusItem={navigation.focusItem} />
          )}
          {navigation.section === 'logging' && (
            <SessionLoggingSection onDirtyChange={navigation.setLoggingDirty} />
          )}
          {navigation.section === 'highlighting' && <HighlightProfilesSection />}
          {navigation.section === 'behavior' && <BehaviorSection />}
          {navigation.section === 'x11' && <X11Section />}
          {navigation.section === 'keyboard' && <KeyboardSection />}
          {navigation.section === 'passwords' && <PasswordVaultSection />}
          {navigation.section === 'data' && (
            <DataTransferSection
              onImportMobaXterm={() => onImport('mobaxterm')}
              onImportSecureCrt={() => onImport('securecrt')}
            />
          )}
          {navigation.section === 'debug' && <DebugSection />}
          {navigation.section === 'about' && <AboutSection />}
        </Box>
      </Box>
    </Box>
  );
}

/** Settings as a dialog over the window, as a regular browser shows them. */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [target] = useState(() => useUiStore.getState().settingsTarget);
  const navigation = useSettingsNavigation(target);
  const [sessionImport, setSessionImport] = useState<SessionImportSource | null>(null);
  const close = () => navigation.leaveSection(() => setOpen(false));

  if (sessionImport) {
    return (
      <ClientSessionImportDialog source={sessionImport} onClose={() => setSessionImport(null)} />
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth={false}
      aria-labelledby="settings-dialog-title"
      // One size for every section, so switching never makes the dialog jump.
      slotProps={{
        paper: {
          sx: {
            width: 'min(1000px, calc(100% - 64px))',
            height: 'min(720px, calc(100% - 64px))',
            overflow: 'hidden',
          },
        },
      }}
    >
      <DialogTitle
        id="settings-dialog-title"
        sx={{
          display: 'flex',
          alignItems: 'center',
          py: 1.25,
          pl: 2.5,
          pr: 1.25,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box component="span" sx={{ flex: 1, fontSize: 16, fontWeight: 650 }}>
          Settings
        </Box>
        <Tooltip title="Close (Esc)">
          <IconButton aria-label="Close" size="small" onClick={close}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <SettingsBody navigation={navigation} onImport={setSessionImport} />
    </Dialog>
  );
}

/** A native color well with the swatch framed like the other controls. */
function ColorWell({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Box
      component="input"
      type="color"
      aria-label={label}
      value={value}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      sx={{
        width: 34,
        height: 28,
        p: 0.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: 0.75,
        bgcolor: 'transparent',
        cursor: 'pointer',
      }}
    />
  );
}

/** Slider plus its current value, for the right-hand side of a row. */
function RowSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <Slider
        size="small"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(_event, next) => onChange(next as number)}
        sx={{ width: 180 }}
      />
      <Typography
        variant="body2"
        color={disabled ? 'textDisabled' : undefined}
        sx={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 550 }}
      >
        {display}
      </Typography>
    </>
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
  const customSchemes = useCustomTerminalSchemes();
  const schemeTheme = terminalScheme(
    terminalSchemeIdForMode(prefs, effectiveThemeMode),
    customSchemes,
  ).theme;
  const schemeForeground = schemeTheme.foreground ?? '#cccccc';
  const schemeBackground = schemeTheme.background ?? '#1e1e1e';
  const dimStrength = clampInactivePaneDimStrength(prefs.inactivePaneDimStrength);

  return (
    <SettingsPage
      title="Appearance"
      description="How Muxus and its terminals look on this machine. Changes apply to open terminals right away."
    >
      <SettingsGroup title="Window">
        <SettingRow
          label="Theme"
          description="System follows your operating system's light or dark setting."
          control={
            <ToggleButtonGroup
              exclusive
              size="small"
              aria-label="Theme"
              value={prefs.themeMode}
              onChange={(_e, v: ThemeMode | null) => {
                if (v) prefs.set({ themeMode: v });
              }}
            >
              <ToggleButton value="light" sx={{ px: 1.75 }}>
                Light
              </ToggleButton>
              <ToggleButton value="os" sx={{ px: 1.75 }}>
                System
              </ToggleButton>
              <ToggleButton value="dark" sx={{ px: 1.75 }}>
                Dark
              </ToggleButton>
            </ToggleButtonGroup>
          }
        />
        <SettingRow
          label="Interface scale"
          description={`Scales the whole window. Terminal text has its own zoom${
            zoomInChord && zoomOutChord ? ` (${zoomInChord} / ${zoomOutChord} or Ctrl+scroll)` : ' (Ctrl+scroll)'
          }, which this does not touch.`}
          control={
            <RowSelect
              id="settings-interface-zoom"
              label="Interface scale"
              width={150}
              value={String(clampInterfaceZoom(prefs.interfaceZoom))}
              onChange={(value) => prefs.set({ interfaceZoom: Number(value) })}
              options={INTERFACE_ZOOM_STEPS.map(
                (step) =>
                  [String(step), `${interfaceZoomLabel(step)}${step === 1 ? ' (default)' : ''}`] as const,
              )}
            />
          }
        />
      </SettingsGroup>

      <LayoutSettings />

      <SettingsGroup title="Status bar">
        <SettingRow
          label="Show status bar"
          labelFor="settings-status-bar"
          description="The active session's host along the bottom of the window. SSH hosts are read every few seconds with a short command over the open connection; nothing is installed on them."
          control={
            <Switch
              id="settings-status-bar"
              size="small"
              checked={prefs.showStatusBar}
              onChange={(event) => prefs.set({ showStatusBar: event.target.checked })}
            />
          }
        />
        <SettingRow
          label="Items"
          description="Right-click the bar to change these without opening Settings."
          disabled={!prefs.showStatusBar}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              columnGap: 2,
              mt: 1,
            }}
          >
            {STATUS_BAR_ITEMS.map((item) => (
              <FormControlLabel
                key={item}
                sx={{ m: 0 }}
                disabled={!prefs.showStatusBar}
                control={
                  <Checkbox
                    size="small"
                    checked={prefs.statusBarItems.includes(item)}
                    onChange={(event) =>
                      prefs.set({
                        statusBarItems: withStatusBarItem(
                          prefs.statusBarItems,
                          item,
                          event.target.checked,
                        ),
                      })
                    }
                  />
                }
                label={<Typography variant="body2">{STATUS_BAR_ITEM_LABELS[item]}</Typography>}
              />
            ))}
          </Box>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Terminal colors">
        <SettingRow
          label="Light terminal theme"
          description="Used while the application theme is light."
          control={
            <Box sx={{ width: 280 }}>
              <TerminalSchemeSelect
                id="light-terminal-theme"
                label="Light terminal theme"
                hideLabel
                value={prefs.lightTerminalScheme}
                onChange={(lightTerminalScheme) => prefs.set({ lightTerminalScheme })}
              />
            </Box>
          }
        />
        <SettingRow
          label="Dark terminal theme"
          description="Used while the application theme is dark."
          control={
            <Box sx={{ width: 280 }}>
              <TerminalSchemeSelect
                id="dark-terminal-theme"
                label="Dark terminal theme"
                hideLabel
                value={prefs.darkTerminalScheme}
                onChange={(darkTerminalScheme) => prefs.set({ darkTerminalScheme })}
              />
            </Box>
          }
        />
        <SettingRow
          label="Text color"
          description={
            prefs.fontColor
              ? "Replaces the scheme's default text color. Output that picks its own ANSI colors keeps the scheme palette."
              : 'Following the color scheme.'
          }
          control={
            <>
              {prefs.fontColor ? (
                <Button size="small" onClick={() => prefs.set({ fontColor: '' })}>
                  Use scheme color
                </Button>
              ) : null}
              <ColorWell
                label="Text color"
                value={prefs.fontColor || schemeForeground}
                onChange={(fontColor) => prefs.set({ fontColor })}
              />
            </>
          }
        />
        <SettingRow
          label="Background color"
          description={
            prefs.backgroundColor
              ? "Replaces the scheme's background in every terminal."
              : 'Following the color scheme.'
          }
          control={
            <>
              {prefs.backgroundColor ? (
                <Button size="small" onClick={() => prefs.set({ backgroundColor: '' })}>
                  Use scheme color
                </Button>
              ) : null}
              <ColorWell
                label="Background color"
                value={prefs.backgroundColor || schemeBackground}
                onChange={(backgroundColor) => prefs.set({ backgroundColor })}
              />
            </>
          }
        />
      </SettingsGroup>

      <CustomTerminalSchemeSettings />

      <SettingsGroup title="Terminal font">
        <SettingRow
          label="Font family"
          labelFor="settings-font-family"
          description={
            fontCatalogLoading ? (
              'Reading installed fonts…'
            ) : selectedFontAvailable === false ? (
              <Box component="span" sx={{ color: 'error.main' }}>
                {prefs.fontFamily.trim() || 'This font'} is not installed; JetBrains Mono is used instead.
              </Box>
            ) : installedFontFamilies ? (
              'JetBrains Mono is bundled; the other choices are installed on this machine.'
            ) : (
              'JetBrains Mono is bundled; other font names use the system installation when available.'
            )
          }
          control={
            <Autocomplete
              id="settings-font-family"
              freeSolo
              loading={fontCatalogLoading}
              options={fontFamilies}
              inputValue={prefs.fontFamily}
              onInputChange={(_e, value) => prefs.set({ fontFamily: value })}
              sx={{ width: 280 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  error={!fontCatalogLoading && selectedFontAvailable === false}
                />
              )}
            />
          }
        />
        <SettingRow
          label="Font size"
          control={
            <RowSlider
              label="Font size"
              min={8}
              max={24}
              value={prefs.monoFontSize}
              display={`${prefs.monoFontSize}px`}
              onChange={(monoFontSize) => prefs.set({ monoFontSize })}
            />
          }
        />
        <SettingRow
          label="Line height"
          control={
            <RowSlider
              label="Line height"
              min={1}
              max={1.6}
              step={0.05}
              value={prefs.lineHeight}
              display={prefs.lineHeight.toFixed(2)}
              onChange={(lineHeight) => prefs.set({ lineHeight })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Split panes">
        <SettingRow
          label="Dim inactive panes"
          labelFor="settings-dim-inactive"
          description="Fades every pane except the focused one. Multi-exec panes stay emphasized."
          control={
            <Switch
              id="settings-dim-inactive"
              size="small"
              checked={prefs.dimInactivePanes}
              onChange={(event) => prefs.set({ dimInactivePanes: event.target.checked })}
            />
          }
        />
        <SettingRow
          label="Dimming strength"
          disabled={!prefs.dimInactivePanes}
          control={
            <RowSlider
              label="Inactive pane dimming strength"
              min={MIN_INACTIVE_PANE_DIM_STRENGTH * 100}
              max={MAX_INACTIVE_PANE_DIM_STRENGTH * 100}
              step={5}
              value={dimStrength * 100}
              display={`${Math.round(dimStrength * 100)}%`}
              disabled={!prefs.dimInactivePanes}
              onChange={(value) => prefs.set({ inactivePaneDimStrength: value / 100 })}
            />
          }
        />
        <SettingRow
          label="Outline the focused pane"
          labelFor="settings-active-pane-border"
          description="A thin accent outline around the pane that has focus."
          control={
            <Switch
              id="settings-active-pane-border"
              size="small"
              checked={prefs.activePaneBorder}
              onChange={(event) => prefs.set({ activePaneBorder: event.target.checked })}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** The layout toggles share one width so the groups line up; "Terminal" is the longest label. */
const layoutToggleSx = { px: 1.5, gap: 0.75, minWidth: 102 } as const;

/** Where the hosts sidebar, the file browser and the command bar dock, beside a live miniature. */
function LayoutSettings() {
  const sidebarPosition = usePrefsStore((s) => s.sidebarPosition);
  const fileBrowserPosition = usePrefsStore((s) => s.fileBrowserPosition);
  const commandBarPosition = usePrefsStore((s) => s.commandBarPosition);
  const showCommandBar = usePrefsStore((s) => s.showCommandBar);
  // The same rule as the bar itself: it shows once there is a button or a group.
  const hasCommandButtons = usePrefsStore(
    (s) => s.commandButtons.length > 0 || s.commandButtonGroups.length > 1,
  );
  const set = usePrefsStore((s) => s.set);
  const commandBarNote = !showCommandBar
    ? 'Turned off. Switch it back on from the saved command buttons control in the top bar.'
    : !hasCommandButtons
      ? 'Appears once a command button has been saved.'
      : 'Holds your saved command buttons.';

  return (
    <Box>
      <SettingsGroup title="Layout" flush>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
          <Box sx={{ p: 2, pr: { xs: 2, sm: 0.5 } }}>
            <LayoutPreview
              sidebarPosition={sidebarPosition}
              fileBrowserPosition={fileBrowserPosition}
              commandBarPosition={commandBarPosition}
            />
          </Box>
          <Box sx={{ flex: '1 1 300px', minWidth: 0 }}>
            <SettingRow
              label="Hosts sidebar"
              description="The saved hosts and folders."
              control={
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  aria-label="Hosts sidebar"
                  value={sidebarPosition}
                  onChange={(_e, value: SidebarPosition | null) => {
                    if (value) set({ sidebarPosition: value });
                  }}
                >
                  <ToggleButton value="left" sx={layoutToggleSx}>
                    {/* The glyph draws its panel on the right; mirrored, it shows the left. */}
                    <ViewSidebarOutlinedIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
                    Left
                  </ToggleButton>
                  <ToggleButton value="right" sx={layoutToggleSx}>
                    <ViewSidebarOutlinedIcon fontSize="small" />
                    Right
                  </ToggleButton>
                </ToggleButtonGroup>
              }
            />
            <SettingRow
              label="File browser"
              description="Beside each SSH terminal, or as a tab in the sidebar that follows the active session."
              control={
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  aria-label="File browser"
                  value={fileBrowserPosition}
                  onChange={(_e, value: FileBrowserPosition | null) => {
                    if (value) set({ fileBrowserPosition: value });
                  }}
                >
                  <ToggleButton value="pane" sx={layoutToggleSx}>
                    <VerticalSplitOutlinedIcon fontSize="small" />
                    Terminal
                  </ToggleButton>
                  <ToggleButton value="sidebar" sx={layoutToggleSx}>
                    <ViewSidebarOutlinedIcon
                      fontSize="small"
                      sx={sidebarPosition === 'left' ? { transform: 'scaleX(-1)' } : undefined}
                    />
                    Sidebar
                  </ToggleButton>
                </ToggleButtonGroup>
              }
            />
            <SettingRow
              label="Command bar"
              description={commandBarNote}
              control={
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  aria-label="Command bar"
                  value={commandBarPosition}
                  onChange={(_e, value: CommandBarPosition | null) => {
                    if (value) set({ commandBarPosition: value });
                  }}
                >
                  <ToggleButton value="top" sx={layoutToggleSx}>
                    <VerticalAlignTopIcon fontSize="small" />
                    Top
                  </ToggleButton>
                  <ToggleButton value="bottom" sx={layoutToggleSx}>
                    <VerticalAlignBottomIcon fontSize="small" />
                    Bottom
                  </ToggleButton>
                </ToggleButtonGroup>
              }
            />
          </Box>
        </Box>
      </SettingsGroup>
      <Typography variant="caption" color="textSecondary" component="p" sx={{ mt: 1, mb: 0 }}>
        Right-click empty space in the sidebar, or the command bar itself, to move either one
        without opening Settings. The file browser moves with the button in its header.
      </Typography>
    </Box>
  );
}

function TerminalSection() {
  const prefs = usePrefsStore();

  return (
    <SettingsPage
      title="Terminal"
      description="How terminals behave. Changes apply to open terminals too."
    >
      <SettingsGroup title="Cursor">
        <SettingRow
          label="Cursor style"
          control={
            <ToggleButtonGroup
              exclusive
              size="small"
              aria-label="Cursor style"
              value={prefs.cursorStyle}
              onChange={(_e, v: 'block' | 'underline' | 'bar' | null) => {
                if (v) prefs.set({ cursorStyle: v });
              }}
            >
              <ToggleButton value="block" sx={{ px: 1.5, fontFamily: 'monospace' }}>
                ▉ Block
              </ToggleButton>
              <ToggleButton value="underline" sx={{ px: 1.5, fontFamily: 'monospace' }}>
                ▁ Underline
              </ToggleButton>
              <ToggleButton value="bar" sx={{ px: 1.5, fontFamily: 'monospace' }}>
                ▏ Bar
              </ToggleButton>
            </ToggleButtonGroup>
          }
        />
        <SettingRow
          label="Blinking cursor"
          labelFor="settings-cursor-blink"
          control={
            <Switch
              id="settings-cursor-blink"
              size="small"
              checked={prefs.cursorBlink}
              onChange={(e) => prefs.set({ cursorBlink: e.target.checked })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Clipboard & mouse">
        <SettingRow
          label="Right-click"
          description="What a right-click in a terminal does."
          control={
            <RowSelect<RightClickAction>
              id="settings-right-click"
              label="Right-click"
              width={280}
              value={prefs.rightClickAction}
              onChange={(rightClickAction) => prefs.set({ rightClickAction })}
              options={[
                ['copy-paste', 'Copy selection, otherwise paste'],
                ['paste', 'Always paste'],
                ['menu', 'Show context menu'],
              ]}
            />
          }
        />
        <SettingRow
          label="Open terminal links"
          description="The click that opens file paths and web addresses. A modifier leaves plain clicks free for selecting text."
          control={
            <RowSelect<TerminalFileLinkActivation>
              id="settings-terminal-links"
              label="Open terminal links"
              width={280}
              value={terminalFileLinkActivationForPlatform(prefs.terminalFileLinkActivation, IS_MAC)}
              onChange={(terminalFileLinkActivation) => prefs.set({ terminalFileLinkActivation })}
              options={TERMINAL_FILE_LINK_ACTIVATION_OPTIONS.map(
                (option) => [option.value, option.label] as const,
              )}
            />
          }
        />
        <SettingRow
          label="Copy on select"
          labelFor="settings-copy-on-select"
          description="Copy selected terminal text to the clipboard automatically."
          control={
            <Switch
              id="settings-copy-on-select"
              size="small"
              checked={prefs.copyOnSelect}
              onChange={(e) => prefs.set({ copyOnSelect: e.target.checked })}
            />
          }
        />
        <SettingRow
          label="Allow terminal clipboard writes (OSC 52)"
          labelFor="settings-osc52"
          description="Lets terminal programs such as tmux and Zellij replace the system clipboard. Clipboard reads remain blocked."
          control={
            <Switch
              id="settings-osc52"
              size="small"
              checked={prefs.allowOsc52ClipboardWrite}
              onChange={(e) => prefs.set({ allowOsc52ClipboardWrite: e.target.checked })}
            />
          }
        />
        <SettingRow
          label="Confirm multiline pastes"
          labelFor="settings-paste-warn"
          description="Preview before pasted text can run several shell commands."
          control={
            <Switch
              id="settings-paste-warn"
              size="small"
              checked={prefs.pasteWarnMultiline}
              onChange={(e) => prefs.set({ pasteWarnMultiline: e.target.checked })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Paste pacing">
        <SettingRow
          label="Delay after each line"
          labelFor="settings-paste-line-delay"
          description="Type pastes in a line at a time, for consoles and network devices that drop input sent all at once. 0 sends pastes at once. Hosts can set their own under Terminal appearance."
          control={
            <TextField
              id="settings-paste-line-delay"
              type="number"
              value={prefs.pasteLineDelayMs}
              onChange={(e) =>
                prefs.set({ pasteLineDelayMs: parsePasteDelay(e.target.value, 'line') ?? 0 })
              }
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
                htmlInput: { min: 0, max: PASTE_DELAY_MAX.line, step: 50 },
              }}
              sx={{ width: 140 }}
            />
          }
        />
        <SettingRow
          label="Delay after each character"
          labelFor="settings-paste-char-delay"
          description="Also wait after every character, for devices that cannot keep up within a line."
          control={
            <TextField
              id="settings-paste-char-delay"
              type="number"
              value={prefs.pasteCharDelayMs}
              onChange={(e) =>
                prefs.set({ pasteCharDelayMs: parsePasteDelay(e.target.value, 'char') ?? 0 })
              }
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
                htmlInput: { min: 0, max: PASTE_DELAY_MAX.char },
              }}
              sx={{ width: 140 }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Buffer & rendering">
        <SettingRow
          label="Scrollback lines"
          labelFor="settings-scrollback"
          description="How much output each terminal keeps above the screen."
          control={
            <TextField
              id="settings-scrollback"
              type="number"
              value={prefs.scrollback}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 1_000_000) prefs.set({ scrollback: v });
              }}
              slotProps={{ htmlInput: { min: 0, max: 1_000_000 } }}
              sx={{ width: 140 }}
            />
          }
        />
        <SettingRow
          label="GPU renderer (WebGL)"
          labelFor="settings-webgl"
          description="Paints terminals on the GPU instead of the DOM: smoother under heavy output, slightly more CPU while idle. Where WebGL is unavailable, terminals keep the standard renderer."
          control={
            <Switch
              id="settings-webgl"
              size="small"
              checked={prefs.webglRenderer}
              onChange={(e) => prefs.set({ webglRenderer: e.target.checked })}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

const SSH_KEEPALIVE_CHOICES = [0, 15, DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS, 60, 120];

const NEW_SSH_HOST_STORAGE_OPTIONS = [
  ['muxus', 'Muxus app data only'],
  ['openssh', 'OpenSSH config'],
] as const satisfies ReadonlyArray<readonly [NewSshHostStorage, string]>;

const SIDEBAR_OPEN_GESTURE_OPTIONS = [
  ['click', 'Single click'],
  ['double-click', 'Double-click'],
] as const satisfies ReadonlyArray<readonly [SidebarOpenGesture, string]>;

function BehaviorSection() {
  const prefs = usePrefsStore();
  const keepaliveOptions: Array<readonly [number, string]> = [
    [0, 'SSH configuration only'],
    [15, 'Every 15 seconds'],
    [DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS, 'Every 30 seconds (recommended)'],
    [60, 'Every minute'],
    [120, 'Every 2 minutes'],
    // A hand-edited or newer-version value must stay visible and active
    // instead of rendering the select blank.
    ...(SSH_KEEPALIVE_CHOICES.includes(prefs.sshKeepaliveIntervalSeconds)
      ? []
      : [
          [
            prefs.sshKeepaliveIntervalSeconds,
            `Every ${prefs.sshKeepaliveIntervalSeconds} seconds (custom)`,
          ] as const,
        ]),
  ];

  return (
    <SettingsPage
      title="Behavior"
      description="How tabs close, how sidebar entries open, where new SSH hosts are saved, what a new SSH session reports, and how sessions come back after a restart or a dropped connection."
    >
      <SettingsGroup title="Tabs">
        <SettingRow
          label="Confirm before closing a live session"
          labelFor="settings-confirm-close"
          description="Closing a connected tab ends its shell."
          control={
            <Switch
              id="settings-confirm-close"
              size="small"
              checked={prefs.confirmCloseConnected}
              onChange={(e) => prefs.set({ confirmCloseConnected: e.target.checked })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Hosts sidebar">
        <SettingRow
          label="Open hosts with"
          description="With double-click, a single click selects a host, as in a file manager. Local terminals open the same way, and Enter opens either way."
          control={
            <RowSelect<SidebarOpenGesture>
              id="settings-sidebar-open-gesture"
              label="Open hosts with"
              value={prefs.sidebarOpenGesture}
              onChange={(sidebarOpenGesture) => prefs.set({ sidebarOpenGesture })}
              options={SIDEBAR_OPEN_GESTURE_OPTIONS}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="New hosts">
        <SettingRow
          label="Save new SSH hosts in"
          description="The host editor starts with this choice, and each new host can still pick the other. OpenSSH config also works with ssh in any terminal."
          control={
            <RowSelect<NewSshHostStorage>
              id="settings-new-ssh-host-storage"
              label="Save new SSH hosts in"
              value={prefs.newSshHostStorage}
              onChange={(newSshHostStorage) => prefs.set({ newSshHostStorage })}
              options={NEW_SSH_HOST_STORAGE_OPTIONS}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Connecting">
        <SettingRow
          label="Show a summary when an SSH session connects"
          labelFor="settings-ssh-session-summary"
          description="Prints the route, server, login method and encryption above the remote shell, and whether compression, the SFTP browser, X11 and agent forwarding are active."
          control={
            <Switch
              id="settings-ssh-session-summary"
              size="small"
              checked={prefs.sshSessionSummary}
              onChange={(e) => prefs.set({ sshSessionSummary: e.target.checked })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Restore & reconnect">
        <SettingRow
          label="SSH keepalive interval"
          description="Keeps idle SSH connections alive through firewalls and NAT. A host's ServerAliveInterval takes precedence; changes apply on reconnect."
          control={
            <RowSelect<number>
              id="settings-ssh-keepalive"
              label="SSH keepalive interval"
              width={250}
              value={prefs.sshKeepaliveIntervalSeconds}
              onChange={(sshKeepaliveIntervalSeconds) => prefs.set({ sshKeepaliveIntervalSeconds })}
              options={keepaliveOptions}
            />
          }
        />
        <SettingRow
          label="Automatically reconnect remote sessions"
          labelFor="settings-auto-reconnect"
          description="Restoring a workspace dials its SSH, Telnet, serial and remote desktop tabs, and a dropped connection redials a few times before waiting for a key press. Off: remote tabs wait until asked."
          control={
            <Switch
              id="settings-auto-reconnect"
              size="small"
              checked={prefs.autoReconnectRemote}
              onChange={(e) => prefs.set({ autoReconnectRemote: e.target.checked })}
            />
          }
        />
        <SettingRow
          label="Restore terminal history"
          labelFor="settings-restore-scrollback"
          description="Recent output is saved locally every few seconds and shown again above the new session after a restore or reconnect."
          control={
            <Switch
              id="settings-restore-scrollback"
              size="small"
              checked={prefs.restoreScrollback}
              onChange={(e) => prefs.set({ restoreScrollback: e.target.checked })}
            />
          }
        />
      </SettingsGroup>
      <LinkHandlerSettings />
    </SettingsPage>
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
    <SettingsPage
      title="Keyboard"
      description="How splits and numbered tabs behave, and every shortcut in one place."
    >
      <SettingsGroup title="Panes & tabs">
        <SettingRow
          label="New splits continue the current session"
          labelFor="settings-split-inherits"
          description="Splitting opens a second session on the same host (SSH reuses the live connection). Off: the new pane asks what to start. Serial consoles always ask."
          control={
            <Switch
              id="settings-split-inherits"
              size="small"
              checked={splitInheritsSession}
              onChange={(e) => set({ splitInheritsSession: e.target.checked })}
            />
          }
        />
        <SettingRow
          label="Show tab numbers"
          description="Tabs are numbered across the whole window and update when tabs or panes move."
          control={
            <RowSelect<TabNumberVisibility>
              id="settings-tab-numbers"
              label="Show tab numbers"
              width={200}
              value={tabNumberVisibility}
              onChange={(value) => set({ tabNumberVisibility: value })}
              options={[
                ['shortcut', 'While Alt is held'],
                ['always', 'Always'],
              ]}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="Layout keys"
        action={
          <Button size="small" startIcon={<KeyboardOutlinedIcon />} onClick={() => setShortcutsOpen(true)}>
            All shortcuts{customCount > 0 ? ` · ${customCount} customized` : ''}
          </Button>
        }
      >
        <KeyboardSummaryRow label="Split the focused pane in any direction" chord={splitChord} />
        <KeyboardSummaryRow label="Move focus between panes" chord={focusChord} />
        <KeyboardSummaryRow label="Jump to a window-wide numbered tab" chord={numberedTabChord} />
        <KeyboardSummaryRow label="Send the current tab to another pane" chord={moveChord} />
        <KeyboardSummaryRow label="Zoom a pane / restore the layout" chord={zoomChord} />
      </SettingsGroup>
    </SettingsPage>
  );
}

function KeyboardSummaryRow({ label, chord }: { label: string; chord?: string }) {
  return (
    <Box
      className="settings-row"
      sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1 }}
    >
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={chordSx()}>
        {chord ?? 'Unbound'}
      </Typography>
    </Box>
  );
}

/** The foot of a form that commits explicitly: its unsaved state and its Save button. */
function SaveBar({
  dirty,
  disabled,
  label,
  onSave,
}: {
  dirty: boolean;
  disabled: boolean;
  label: string;
  onSave: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        py: 1.25,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Typography variant="caption" sx={{ flex: 1, fontWeight: 550, color: statusTextColor('warning') }}>
        {dirty ? 'Unsaved changes' : null}
      </Typography>
      <Button variant="contained" disabled={disabled} onClick={onSave}>
        {label}
      </Button>
    </Box>
  );
}

function SessionLoggingSection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { data: policy, isLoading } = useSessionLoggingPolicy('*');
  const {
    data: localPolicy,
    isLoading: localPolicyLoading,
  } = useSessionLoggingPolicy('local');
  const storedDefault = useMemo(
    () => (policy ? hostSessionLoggingDraft(policy, false) : undefined),
    [policy],
  );
  const storedLocal = useMemo(
    () => (localPolicy ? hostSessionLoggingDraft(localPolicy, !localPolicy.overridden) : undefined),
    [localPolicy],
  );
  const {
    draft,
    dirty: defaultEdited,
    edit: set,
    saved: defaultSaved,
  } = useSettingsDraft(
    storedDefault,
    { ...FALLBACK_SESSION_LOGGING_POLICY, inherit: false, loaded: false },
    sameSessionLoggingDraft,
  );
  const {
    draft: localDraft,
    dirty: localEdited,
    edit: setLocal,
    saved: localSaved,
  } = useSettingsDraft(
    storedLocal,
    { ...FALLBACK_SESSION_LOGGING_POLICY, inherit: true, loaded: false },
    sameSessionLoggingDraft,
  );
  const [historyEdited, setHistoryEdited] = useState(false);
  const [logFilesEdited, setLogFilesEdited] = useState(false);
  const savePolicy = useSaveSessionLoggingPolicy(() => {
    defaultSaved();
    showToast('success', 'Default session logging settings saved.');
  });
  const saveLocalPolicy = useSaveSessionLoggingPolicy(() => {
    localSaved();
    showToast('success', 'Local terminal logging settings saved.');
  });

  useEffect(() => {
    onDirtyChange(defaultEdited || localEdited || historyEdited || logFilesEdited);
  }, [defaultEdited, localEdited, historyEdited, logFilesEdited, onDirtyChange]);

  return (
    <SettingsPage
      title="Session logging"
      description="Record terminal sessions to search and replay them later, or write them to plain-text log files. Off by default. Unlike the rest of Settings, changes here apply once saved, and only to sessions opened afterwards."
    >
      <SettingsGroup
        title="Default policy"
        description="Inherited by every host without a logging setting of its own."
        flush
      >
        <Box sx={{ p: 2 }}>
          <SessionLoggingPolicyFields value={draft} onChange={set} />
        </Box>
        <SaveBar
          dirty={defaultEdited}
          label="Save default policy"
          disabled={isLoading || !draft.loaded || !defaultEdited || savePolicy.isPending}
          onSave={() =>
            savePolicy.mutate({
              profileKey: '*',
              policy: sessionLoggingPolicyInput(draft),
            })
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="Local terminals"
        description="Local shells have no host entry, so their optional override lives here. It applies to newly opened local terminals."
        flush
      >
        <Box sx={{ p: 2 }}>
          <SessionLoggingPolicyFields value={localDraft} onChange={setLocal} allowInherit />
        </Box>
        <SaveBar
          dirty={localEdited}
          label="Save local terminal policy"
          disabled={
            localPolicyLoading ||
            !localDraft.loaded ||
            !localEdited ||
            saveLocalPolicy.isPending
          }
          onSave={() =>
            saveLocalPolicy.mutate({
              profileKey: 'local',
              policy: localDraft.inherit
                ? null
                : sessionLoggingPolicyInput(localDraft),
            })
          }
        />
      </SettingsGroup>
      <LogFileSettings onDirtyChange={setLogFilesEdited} />
      <HistoryStorageSettings onDirtyChange={setHistoryEdited} />
    </SettingsPage>
  );
}

interface LogFileDraft {
  directory: string;
  filenamePattern: string;
  timestamps: boolean;
}

function sameLogFileDraft(a: LogFileDraft, b: LogFileDraft): boolean {
  return (
    a.directory.trim() === b.directory.trim() &&
    a.filenamePattern.trim() === b.filenamePattern.trim() &&
    a.timestamps === b.timestamps
  );
}

function LogFileSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { data: status, isLoading } = useSessionLogFiles();
  const settings = status?.settings;
  const stored = useMemo(
    () =>
      settings
        ? {
            directory: settings.directory ?? '',
            filenamePattern: settings.filenamePattern,
            timestamps: settings.timestamps,
          }
        : undefined,
    [settings],
  );
  const {
    draft,
    dirty: edited,
    edit: set,
    saved,
  } = useSettingsDraft<LogFileDraft>(
    stored,
    { directory: '', filenamePattern: DEFAULT_SESSION_LOG_FILE_PATTERN, timestamps: false },
    sameLogFileDraft,
  );
  useEffect(() => onDirtyChange(edited), [edited, onDirtyChange]);
  const save = useSaveSessionLogFileSettings(() => {
    saved();
    showToast('success', 'Log file settings saved.');
  });
  const patternError = sessionLogFilePatternError(draft.filenamePattern);
  const example = patternError
    ? undefined
    : sessionLogFileName(draft.filenamePattern, {
        host: 'router1',
        title: 'Core router',
        kind: 'ssh',
        startedAt: new Date(),
      }).join('/');

  return (
    <SettingsGroup
      title="Log files"
      description="Plain-text logs written while a session runs, started from the terminal menu or for every session by the policies above. They are ordinary files: retention and quotas never remove them."
      flush
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          label="Log folder"
          value={draft.directory}
          onChange={(event) => set({ directory: event.target.value })}
          helperText="Leave blank for the default folder."
          placeholder={status?.activeDirectory}
          slotProps={{
            htmlInput: { style: { fontFamily: 'monospace' } },
            inputLabel: { shrink: true },
          }}
          fullWidth
        />
        <TextField
          label="File name"
          value={draft.filenamePattern}
          onChange={(event) => set({ filenamePattern: event.target.value })}
          error={!!patternError}
          helperText={
            patternError ??
            `{host}, {title}, {kind}, {date} and {time} are filled in; / starts a subfolder. Example: ${example}`
          }
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          fullWidth
        />
      </Box>
      <SettingRow
        label="Show timestamps (UTC)"
        labelFor="settings-log-file-timestamps"
        description="Prefix each line with the time it last changed, as in the clean log."
        control={
          <Switch
            id="settings-log-file-timestamps"
            size="small"
            checked={draft.timestamps}
            onChange={(event) => set({ timestamps: event.target.checked })}
          />
        }
      />
      <SaveBar
        dirty={edited}
        label="Save log file settings"
        disabled={isLoading || !status || !edited || !!patternError || save.isPending}
        onSave={() =>
          save.mutate({
            directory: draft.directory.trim() || undefined,
            filenamePattern: draft.filenamePattern.trim(),
            timestamps: draft.timestamps,
          })
        }
      />
    </SettingsGroup>
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

function sameHistoryStorageDraft(a: HistoryStorageDraft, b: HistoryStorageDraft): boolean {
  return (Object.keys(a) as (keyof HistoryStorageDraft)[]).every(
    (key) => a[key].trim() === b[key].trim(),
  );
}

function HistoryStorageSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { data: status, isLoading } = useSessionHistoryStorage();
  // The status refetches for its usage figures; only the settings feed the form.
  const settings = status?.settings;
  const stored = useMemo(
    () =>
      settings
        ? {
            storageLocation: settings.storageLocation ?? '',
            maxTotalGiB: bytesToGiB(settings.maxTotalBytes),
            minFreeGiB: bytesToGiB(settings.minFreeBytes),
            minFreePercent: String(settings.minFreePercent),
            maxAgeDays: settings.maxAgeDays ? String(settings.maxAgeDays) : '',
          }
        : undefined,
    [settings],
  );
  const {
    draft,
    dirty: edited,
    edit: set,
    saved,
  } = useSettingsDraft(stored, EMPTY_HISTORY_STORAGE_DRAFT, sameHistoryStorageDraft);
  useEffect(() => onDirtyChange(edited), [edited, onDirtyChange]);
  const save = useSaveSessionHistorySettings((next) => {
    saved();
    showToast(
      'success',
      next.restartRequired
        ? 'History limits saved. Restart Muxus to use the new location.'
        : 'History storage limits saved.',
    );
  });

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
    <SettingsGroup
      title="Storage & retention"
      description="The quota counts compressed recordings, the search database and its WAL. Cleanup removes the oldest unpinned finished sessions down to about 85% of the limit."
      flush
    >
      <SettingRow
        label="Current usage"
        description={
          status ? (
            <>
              {formatStorageBytes(status.usageBytes)} used · {formatStorageBytes(status.freeBytes)} free
              <br />
              <Box component="span" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                {status.activeStorageLocation}
              </Box>
            </>
          ) : (
            <Skeleton width={220} />
          )
        }
      >
        {status?.warning ? (
          <Alert severity="warning" variant="outlined" sx={{ mt: 1.25 }}>
            {status.warning}
          </Alert>
        ) : null}
      </SettingRow>
      <Box sx={{ p: 2, pt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          label="History location"
          value={draft.storageLocation}
          onChange={(event) => set({ storageLocation: event.target.value })}
          helperText="Leave blank for the platform default. Takes effect after a restart; existing history stays at its old location."
          placeholder={status?.activeStorageLocation}
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          fullWidth
        />
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(4, minmax(0, 1fr))' },
            gap: 1.5,
          }}
        >
          <TextField
            label="Maximum history (GiB)"
            type="number"
            value={draft.maxTotalGiB}
            onChange={(event) => set({ maxTotalGiB: event.target.value })}
            slotProps={{ htmlInput: { min: 0.0625, step: 0.25 } }}
          />
          <TextField
            label="Minimum free (GiB)"
            type="number"
            value={draft.minFreeGiB}
            onChange={(event) => set({ minFreeGiB: event.target.value })}
            slotProps={{ htmlInput: { min: 0, step: 0.25 } }}
          />
          <TextField
            label="Minimum free (%)"
            type="number"
            value={draft.minFreePercent}
            onChange={(event) => set({ minFreePercent: event.target.value })}
            slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
          />
          <TextField
            label="Maximum age (days)"
            type="number"
            value={draft.maxAgeDays}
            onChange={(event) => set({ maxAgeDays: event.target.value })}
            placeholder="No limit"
            slotProps={{ htmlInput: { min: 1, step: 1 }, inputLabel: { shrink: true } }}
          />
        </Box>
        <Typography variant="caption" color="textSecondary" sx={{ mt: -1 }}>
          A blank maximum age keeps sessions indefinitely, subject to the size and free-space
          limits.
        </Typography>
      </Box>
      <SaveBar
        dirty={edited}
        label="Save storage limits"
        disabled={isLoading || !valid || !edited || save.isPending}
        onSave={() =>
          save.mutate({
            storageLocation: draft.storageLocation.trim() || undefined,
            maxTotalBytes,
            minFreeBytes,
            minFreePercent,
            maxAgeDays,
          })
        }
      />
    </SettingsGroup>
  );
}

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
    <SettingsPage
      title="Debug"
      description="Muxus keeps its own log in memory on this machine. It never leaves it unless you export it, for example to attach to a bug report."
    >
      <SettingsGroup>
        <SettingRow
          label="Capture verbose diagnostic logs"
          labelFor="settings-debug-mode"
          description="Records connection-level detail: every dial, authentication step, SSH agent wait and the raw error behind a failure. Warnings and errors are always captured, even while this is off."
          control={
            <Switch
              id="settings-debug-mode"
              size="small"
              checked={debugMode}
              onChange={(e) => set({ debugMode: e.target.checked })}
            />
          }
        />
        <SettingRow
          label="Application log"
          description="App startup and every connection attempt since launch. If the desktop app fails to start at all, its shell also writes logs/main.log in the app data directory."
          control={
            <>
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
            </>
          }
        />
      </SettingsGroup>
    </SettingsPage>
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
