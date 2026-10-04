import { useRef, useState, type ChangeEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { exportFilename, saveTextFile } from '../save-file.js';
import { confirmAction } from '../state/dialogs.js';
import {
  terminalFontStack,
  useCustomTerminalSchemes,
  usePrefsStore,
  withoutCustomTerminalScheme,
} from '../state/prefs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import {
  MAX_CUSTOM_TERMINAL_SCHEMES,
  MAX_TERMINAL_SCHEME_FILE_BYTES,
  MAX_TERMINAL_SCHEME_NAME_LENGTH,
  SCHEME_ANSI_COLOR_KEYS,
  SCHEME_BASE_COLOR_KEYS,
  SCHEME_BRIGHT_ANSI_COLOR_KEYS,
  createTerminalSchemeDocument,
  customSchemeCopyOf,
  mergeCustomTerminalSchemes,
  parseTerminalSchemeFile,
  terminalSchemeFromCustom,
  type CustomSchemeColorKey,
  type CustomSchemeColors,
  type CustomTerminalScheme,
} from '../terminal/custom-schemes.js';
import type { TerminalScheme } from '../terminal/palette.js';
import { RowSelect, SettingRow, SettingsGroup } from './SettingsLayout.js';
import { SchemeLabel, terminalSchemeGroups } from './TerminalSchemeSelect.js';

const BASE_COLOR_LABELS: Record<(typeof SCHEME_BASE_COLOR_KEYS)[number], string> = {
  background: 'Background',
  foreground: 'Text',
  cursor: 'Cursor',
  selectionBackground: 'Selection',
};

const ANSI_COLOR_LABELS = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** The user's own terminal color schemes: create, edit, import, export and delete. */
export function CustomTerminalSchemeSettings() {
  const schemes = usePrefsStore((state) => state.customTerminalSchemes);
  const setPrefs = usePrefsStore((state) => state.set);
  const fontFamily = usePrefsStore((state) => state.fontFamily);
  const customSchemes = useCustomTerminalSchemes();
  const importInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState('');
  const [newMenuAnchor, setNewMenuAnchor] = useState<HTMLElement | null>(null);
  const selectedScheme = schemes.find((scheme) => scheme.id === selectedId) ?? schemes[0];
  const atLimit = schemes.length >= MAX_CUSTOM_TERMINAL_SCHEMES;

  const updateScheme = (
    id: string,
    patch: Partial<Pick<CustomTerminalScheme, 'name' | 'colors'>>,
  ) => {
    const current = usePrefsStore.getState().customTerminalSchemes;
    setPrefs({
      customTerminalSchemes: current.map((scheme) =>
        scheme.id === id ? { ...scheme, ...patch } : scheme,
      ),
    });
  };

  const addCopyOf = (base: TerminalScheme) => {
    setNewMenuAnchor(null);
    try {
      const current = usePrefsStore.getState().customTerminalSchemes;
      const scheme = customSchemeCopyOf(base, current);
      setPrefs({ customTerminalSchemes: [...current, scheme] });
      setSelectedId(scheme.id);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const deleteScheme = (scheme: CustomTerminalScheme) => {
    void confirmAction({
      title: `Delete ${scheme.name}?`,
      description:
        'A terminal theme set to this scheme returns to its default, and hosts assigned to it follow the application setting again.',
      confirmLabel: 'Delete scheme',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      const prefs = usePrefsStore.getState();
      prefs.set(withoutCustomTerminalScheme(prefs, scheme.id));
      setSelectedId('');
    });
  };

  const exportSchemes = (
    selection: CustomTerminalScheme[],
    filenameTitle: string,
    message: string,
  ) => {
    try {
      const document = createTerminalSchemeDocument(selection);
      saveTextFile(
        exportFilename(filenameTitle, 'muxus-scheme.json'),
        `${JSON.stringify(document, null, 2)}\n`,
        'application/json',
      );
      showToast('success', message);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const importSchemes = async (file: File) => {
    if (file.size > MAX_TERMINAL_SCHEME_FILE_BYTES) {
      showToast('error', 'That color scheme file is too large.');
      return;
    }
    try {
      const imported = parseTerminalSchemeFile(await file.text(), file.name);
      const merged = mergeCustomTerminalSchemes(
        usePrefsStore.getState().customTerminalSchemes,
        imported,
      );
      setPrefs({ customTerminalSchemes: merged });
      const first = merged.find((scheme) => scheme.id === imported[0]?.id);
      setSelectedId(first?.id ?? '');
      showToast(
        'success',
        imported.length === 1 && first
          ? `Imported ${first.name}.`
          : `Imported ${imported.length} color schemes.`,
      );
    } catch (error) {
      showErrorToast(error);
    }
  };

  const chooseImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importSchemes(file);
  };

  return (
    <SettingsGroup
      title={schemes.length ? `Custom color schemes · ${schemes.length}` : 'Custom color schemes'}
      description="Your own schemes are offered in the terminal theme pickers above and in every host's terminal appearance. Start from a copy of any scheme, or import a Windows Terminal (.json) or iTerm2 (.itermcolors) color scheme."
      action={
        <>
          <Button
            size="small"
            startIcon={<AddIcon />}
            aria-haspopup="menu"
            disabled={atLimit}
            onClick={(event) => setNewMenuAnchor(event.currentTarget)}
          >
            New
          </Button>
          <Button
            size="small"
            startIcon={<UploadFileOutlinedIcon />}
            disabled={atLimit}
            onClick={() => importInput.current?.click()}
          >
            Import
          </Button>
        </>
      }
    >
      <Menu
        open={!!newMenuAnchor}
        anchorEl={newMenuAnchor}
        onClose={() => setNewMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxHeight: 390, minWidth: 260 } } }}
      >
        {terminalSchemeGroups(customSchemes).flatMap((group) => [
          <ListSubheader key={group.label}>Copy of · {group.label}</ListSubheader>,
          ...group.schemes.map((scheme) => (
            <MenuItem key={scheme.id} onClick={() => addCopyOf(scheme)}>
              <SchemeLabel scheme={scheme} />
            </MenuItem>
          )),
        ])}
      </Menu>
      <input
        ref={importInput}
        hidden
        type="file"
        aria-label="Import a color scheme file"
        accept=".json,.itermcolors,application/json"
        onChange={chooseImport}
      />
      {selectedScheme ? (
        <>
          <SettingRow
            label="Scheme"
            description="The scheme to edit below."
            control={
              <RowSelect
                id="settings-custom-scheme"
                label="Scheme"
                width={280}
                value={selectedScheme.id}
                onChange={setSelectedId}
                options={schemes.map(
                  (scheme) =>
                    [
                      scheme.id,
                      <SchemeLabel key={scheme.id} scheme={terminalSchemeFromCustom(scheme)} />,
                    ] as const,
                )}
              />
            }
          />
          <SettingRow
            label="Name"
            labelFor="settings-custom-scheme-name"
            control={
              // Keyed so a cleared name never carries over to another scheme.
              <SchemeNameField
                key={selectedScheme.id}
                name={selectedScheme.name}
                onChange={(name) => updateScheme(selectedScheme.id, { name })}
              />
            }
          />
          <Box className="settings-row" sx={{ p: 2 }}>
            <SchemeColorEditor
              colors={selectedScheme.colors}
              fontFamily={fontFamily}
              onChange={(colors) => updateScheme(selectedScheme.id, { colors })}
            />
          </Box>
          <Stack
            className="settings-row"
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap', px: 2, py: 1.25 }}
          >
            <Button
              variant="outlined"
              startIcon={<DownloadOutlinedIcon />}
              onClick={() =>
                exportSchemes(
                  [selectedScheme],
                  `${selectedScheme.name} color scheme`,
                  `Exported ${selectedScheme.name}.`,
                )
              }
            >
              Export scheme
            </Button>
            {schemes.length > 1 ? (
              <Button
                startIcon={<DownloadOutlinedIcon />}
                onClick={() =>
                  exportSchemes(
                    schemes,
                    'color schemes',
                    `Exported ${schemes.length} color schemes.`,
                  )
                }
              >
                Export all
              </Button>
            ) : null}
            <Button
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => deleteScheme(selectedScheme)}
              sx={{ ml: 'auto' }}
            >
              Delete scheme
            </Button>
          </Stack>
        </>
      ) : (
        <Typography
          variant="body2"
          color="textSecondary"
          sx={{ px: 2, py: 2.5, textAlign: 'center' }}
        >
          No custom schemes yet. Create one from a copy of any scheme, or import a color scheme
          file.
        </Typography>
      )}
    </SettingsGroup>
  );
}

/**
 * Only a non-empty name reaches preferences, so a cleared field can never be
 * saved as a scheme without one; leaving the field restores the saved name.
 */
function SchemeNameField({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  // Non-null only while the field holds a name that cannot be saved.
  const [unsaved, setUnsaved] = useState<string | null>(null);
  return (
    <TextField
      id="settings-custom-scheme-name"
      value={unsaved ?? name}
      error={unsaved !== null}
      onChange={(event) => {
        const value = event.target.value;
        if (value.trim()) {
          setUnsaved(null);
          onChange(value);
        } else {
          setUnsaved(value);
        }
      }}
      onBlur={() => setUnsaved(null)}
      slotProps={{ htmlInput: { maxLength: MAX_TERMINAL_SCHEME_NAME_LENGTH } }}
      sx={{ width: 280 }}
    />
  );
}

function SchemeColorEditor({
  colors,
  fontFamily,
  onChange,
}: {
  colors: CustomSchemeColors;
  fontFamily: string;
  onChange: (colors: CustomSchemeColors) => void;
}) {
  const well = (key: CustomSchemeColorKey, label: string) => (
    <ColorWell
      key={key}
      label={label}
      value={colors[key]}
      onChange={(value) => onChange({ ...colors, [key]: value })}
    />
  );
  return (
    <Stack spacing={2}>
      <SchemePreview colors={colors} fontFamily={fontFamily} />
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', columnGap: 3, rowGap: 1 }}>
        {SCHEME_BASE_COLOR_KEYS.map((key) => (
          <Stack key={key} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {well(key, BASE_COLOR_LABELS[key])}
            <Typography variant="body2">{BASE_COLOR_LABELS[key]}</Typography>
          </Stack>
        ))}
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto repeat(8, minmax(0, 1fr))',
          columnGap: 1,
          rowGap: 0.75,
          alignItems: 'center',
          justifyItems: 'center',
        }}
      >
        <span />
        {ANSI_COLOR_LABELS.map((label) => (
          <Typography key={label} variant="caption" color="textSecondary" noWrap>
            {label}
          </Typography>
        ))}
        <Typography variant="body2" sx={{ justifySelf: 'start', pr: 1 }}>
          Normal
        </Typography>
        {SCHEME_ANSI_COLOR_KEYS.map((key, index) => well(key, ANSI_COLOR_LABELS[index]!))}
        <Typography variant="body2" sx={{ justifySelf: 'start', pr: 1 }}>
          Bright
        </Typography>
        {SCHEME_BRIGHT_ANSI_COLOR_KEYS.map((key, index) =>
          well(key, `Bright ${ANSI_COLOR_LABELS[index]!.toLowerCase()}`),
        )}
      </Box>
    </Stack>
  );
}

/** A few lines of typical terminal output painted with the scheme being edited. */
function SchemePreview({ colors, fontFamily }: { colors: CustomSchemeColors; fontFamily: string }) {
  const text = (color: CustomSchemeColorKey, value: string) => (
    <Box component="span" sx={{ color: colors[color] }}>
      {value}
    </Box>
  );
  const prompt = (
    <>
      {text('green', 'deploy@web-01')}:{text('blue', '~/app')}${' '}
    </>
  );
  return (
    <Box
      aria-hidden
      sx={{
        px: 1.5,
        py: 1.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: colors.background,
        color: colors.foreground,
        fontFamily: terminalFontStack(fontFamily),
        fontSize: 12.5,
        lineHeight: 1.6,
        fontVariantLigatures: 'none',
        whiteSpace: 'pre',
        overflow: 'hidden',
      }}
    >
      <div>{prompt}ls</div>
      <div>
        {text('blue', 'conf')}
        {'  '}
        {text('cyan', 'current')}
        {'  '}
        {text('green', 'deploy.sh')}
        {'  '}
        {text('magenta', 'logo.png')}
        {'  '}
        {text('red', 'backup.tar')}
        {'  '}
        {text('yellow', 'notes.txt')}
        {'  README.md'}
      </div>
      <div>{prompt}tail app.log</div>
      <div>
        {text('brightRed', 'ERROR')}
        {'  '}
        {text('brightYellow', 'WARN')}
        {'  '}
        {text('brightBlue', 'INFO')}
        {'  '}
        {text('brightMagenta', 'DEBUG')}
        {'  '}
        {text('brightCyan', 'TRACE')}
        {'  '}
        {text('brightGreen', 'ok')}
        {'  '}
        {text('brightBlack', '# bright colors')}
      </div>
      <div>
        {prompt}
        <Box component="span" sx={{ bgcolor: colors.selectionBackground }}>
          docker compose up
        </Box>
        <Box component="span" sx={{ bgcolor: colors.cursor }}>
          {' '}
        </Box>
      </div>
    </Box>
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
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
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
