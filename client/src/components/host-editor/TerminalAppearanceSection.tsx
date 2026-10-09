import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import {
  terminalSchemeIdForMode,
  useCustomTerminalSchemes,
  usePrefsStore,
  type CommandButtonGroup,
} from '../../state/prefs.js';
import {
  isTerminalSchemeId,
  terminalColorForHost,
  terminalScheme,
  terminalSchemeIdForHost,
} from '../../terminal/palette.js';
import { TerminalSchemeSelect } from '../TerminalSchemeSelect.js';
import { PasteDelayField } from './PasteDelayField.js';

export interface HostTerminalAppearance {
  terminalScheme?: string;
  terminalFontColor?: string;
  terminalBackgroundColor?: string;
  commandButtonGroup?: string;
  pasteLineDelayMs?: number;
  pasteCharDelayMs?: number;
}

/** Terminal colors saved with a host, shared by all three host kinds. */
export function TerminalAppearanceSection({
  value,
  onChange,
}: {
  value: HostTerminalAppearance;
  onChange: (patch: Partial<HostTerminalAppearance>) => void;
}) {
  const customSchemes = useCustomTerminalSchemes();
  const defaults = useTerminalColorDefaults(value.terminalScheme);
  const pasteLineDelayMs = usePrefsStore((state) => state.pasteLineDelayMs);
  const pasteCharDelayMs = usePrefsStore((state) => state.pasteCharDelayMs);

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Terminal appearance
        </Typography>
        <Typography variant="body2" color="textSecondary">
          Distinguish this host in focus mode. Unset values follow the application settings.
        </Typography>
      </Box>
      <TerminalSchemeSelect
        id="host-terminal-scheme"
        label="Color scheme"
        // A scheme that was deleted since inherits, exactly as the terminal does.
        value={
          isTerminalSchemeId(value.terminalScheme, customSchemes) ? value.terminalScheme : ''
        }
        inheritLabel="Use application default"
        onChange={(terminalScheme) => onChange({ terminalScheme: terminalScheme || undefined })}
      />
      <ColorOverride
        label="Text color"
        value={value.terminalFontColor}
        defaultValue={defaults.fontColor}
        onChange={(terminalFontColor) => onChange({ terminalFontColor })}
      />
      <ColorOverride
        label="Background color"
        value={value.terminalBackgroundColor}
        defaultValue={defaults.backgroundColor}
        onChange={(terminalBackgroundColor) => onChange({ terminalBackgroundColor })}
      />
      <Box sx={{ pt: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Command buttons
        </Typography>
        <Typography variant="body2" color="textSecondary">
          The command bar switches to this group while a session to this host is active.
        </Typography>
      </Box>
      <CommandButtonGroupSelect
        value={value.commandButtonGroup}
        onChange={(commandButtonGroup) => onChange({ commandButtonGroup })}
      />
      <Box sx={{ pt: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Paste pacing
        </Typography>
        <Typography variant="body2" color="textSecondary">
          Type pastes in slowly for consoles that drop input sent all at once. Empty follows
          the Terminal settings; 0 sends pastes at once.
        </Typography>
      </Box>
      <Stack direction="row" spacing={1.5}>
        <PasteDelayField
          kind="line"
          value={value.pasteLineDelayMs}
          defaultValue={pasteLineDelayMs}
          onChange={(delay) => onChange({ pasteLineDelayMs: delay })}
        />
        <PasteDelayField
          kind="char"
          value={value.pasteCharDelayMs}
          defaultValue={pasteCharDelayMs}
          onChange={(delay) => onChange({ pasteCharDelayMs: delay })}
        />
      </Stack>
    </Stack>
  );
}

/** Where the bar's group comes from: the one picked there, or one this host names. */
function CommandButtonGroupSelect({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (groupId: string | undefined) => void;
}) {
  const groups = usePrefsStore((state) => state.commandButtonGroups);
  return (
    <TextField
      select
      fullWidth
      label="Command button group"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || undefined)}
      helperText={
        groups.length > 1
          ? 'Another group can still be picked in the bar during the session.'
          : 'Create groups in the command button manager, for example one per vendor.'
      }
    >
      {commandButtonGroupOptions(groups, value).map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/**
 * The choices for a host's command button group. A group deleted since the
 * host named it stays listed, so the select can show what is stored.
 */
export function commandButtonGroupOptions(
  groups: readonly CommandButtonGroup[],
  value: string | undefined,
): Array<{ value: string; label: string }> {
  return [
    { value: '', label: 'Group chosen in the bar' },
    ...(value && !groups.some((group) => group.id === value)
      ? [{ value, label: 'Deleted group' }]
      : []),
    ...groups.map((group) => ({ value: group.id, label: group.name.trim() || 'Untitled group' })),
  ];
}

/**
 * The text and background colors a host gets when it overrides neither: its
 * scheme's, unless the application settings override those.
 */
export function useTerminalColorDefaults(hostScheme: string | undefined): {
  fontColor: string;
  backgroundColor: string;
} {
  const mode = useTheme().palette.mode;
  const applicationSchemeId = usePrefsStore((prefs) =>
    terminalSchemeIdForMode(prefs, mode),
  );
  const applicationFontColor = usePrefsStore((prefs) => prefs.fontColor);
  const applicationBackgroundColor = usePrefsStore((prefs) => prefs.backgroundColor);
  const customSchemes = useCustomTerminalSchemes();
  const scheme = terminalScheme(
    terminalSchemeIdForHost(applicationSchemeId, hostScheme, customSchemes),
    customSchemes,
  );
  return {
    fontColor: terminalColorForHost(scheme.theme.foreground ?? '#cccccc', applicationFontColor),
    backgroundColor: terminalColorForHost(
      scheme.theme.background ?? '#181818',
      applicationBackgroundColor,
    ),
  };
}

export function ColorOverride({
  label,
  value,
  defaultValue,
  onChange,
  mixed = false,
}: {
  label: string;
  value: string | undefined;
  defaultValue: string;
  onChange: (value: string | undefined) => void;
  /** Several hosts with different colors; picking one or the default sets them all. */
  mixed?: boolean;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="textSecondary" sx={{ minWidth: 118 }}>
        {label}
      </Typography>
      <Box
        component="input"
        type="color"
        aria-label={label}
        value={value ?? defaultValue}
        onChange={(event) => onChange(event.target.value)}
        sx={{
          width: 34,
          height: 30,
          p: 0.25,
          border: 1,
          borderColor: 'divider',
          borderRadius: 0.75,
          bgcolor: 'transparent',
          cursor: 'pointer',
        }}
      />
      {mixed ? (
        <Typography variant="caption" color="textSecondary">
          Multiple values
        </Typography>
      ) : null}
      {value || mixed ? (
        <Button size="small" onClick={() => onChange(undefined)}>
          Use application default
        </Button>
      ) : (
        <Typography variant="caption" color="textSecondary">
          Following application default
        </Typography>
      )}
    </Stack>
  );
}
