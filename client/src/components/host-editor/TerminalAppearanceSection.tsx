import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { terminalSchemeIdForMode, usePrefsStore } from '../../state/prefs.js';
import {
  terminalColorForHost,
  terminalScheme,
  terminalSchemeIdForHost,
} from '../../terminal/palette.js';
import { TerminalSchemeSelect } from '../TerminalSchemeSelect.js';

export interface HostTerminalAppearance {
  terminalScheme?: string;
  terminalFontColor?: string;
  terminalBackgroundColor?: string;
}

/** Terminal colors saved with a host, shared by all three host kinds. */
export function TerminalAppearanceSection({
  value,
  onChange,
}: {
  value: HostTerminalAppearance;
  onChange: (patch: Partial<HostTerminalAppearance>) => void;
}) {
  const mode = useTheme().palette.mode;
  const applicationSchemeId = usePrefsStore((prefs) =>
    terminalSchemeIdForMode(prefs, mode),
  );
  const applicationFontColor = usePrefsStore((prefs) => prefs.fontColor);
  const applicationBackgroundColor = usePrefsStore((prefs) => prefs.backgroundColor);
  const scheme = terminalScheme(
    terminalSchemeIdForHost(applicationSchemeId, value.terminalScheme),
  );
  const defaultFontColor = terminalColorForHost(
    scheme.theme.foreground ?? '#cccccc',
    applicationFontColor,
  );
  const defaultBackgroundColor = terminalColorForHost(
    scheme.theme.background ?? '#181818',
    applicationBackgroundColor,
  );

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Terminal appearance
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Distinguish this host in focus mode. Unset values follow the application settings.
        </Typography>
      </Box>
      <TerminalSchemeSelect
        id="host-terminal-scheme"
        label="Color scheme"
        value={value.terminalScheme ?? ''}
        inheritLabel="Use application default"
        onChange={(terminalScheme) => onChange({ terminalScheme: terminalScheme || undefined })}
      />
      <ColorOverride
        label="Text color"
        value={value.terminalFontColor}
        defaultValue={defaultFontColor}
        onChange={(terminalFontColor) => onChange({ terminalFontColor })}
      />
      <ColorOverride
        label="Background color"
        value={value.terminalBackgroundColor}
        defaultValue={defaultBackgroundColor}
        onChange={(terminalBackgroundColor) => onChange({ terminalBackgroundColor })}
      />
    </Stack>
  );
}

function ColorOverride({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  value: string | undefined;
  defaultValue: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 118 }}>
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
      {value ? (
        <Button size="small" onClick={() => onChange(undefined)}>
          Use application default
        </Button>
      ) : (
        <Typography variant="caption" color="text.secondary">
          Following application default
        </Typography>
      )}
    </Stack>
  );
}
