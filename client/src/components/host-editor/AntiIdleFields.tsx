import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import { ANTI_IDLE_TEXT_MAX_LENGTH } from '@muxus/shared';
import { antiIdleIntervalProblem, type AntiIdleDraft } from '../../anti-idle.js';

const MONO_FONT = '"JetBrains Mono", monospace';

/** The anti-idle heading, shared by the host editors and the bulk editor. */
export function AntiIdleIntro({ sx }: { sx?: SxProps<Theme> }) {
  return (
    <Box sx={sx}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        Anti-idle
      </Typography>
      <Typography variant="body2" color="textSecondary">
        Type something after a stretch without input, for devices that close idle sessions.
        Applies to sessions opened after saving.
      </Typography>
    </Box>
  );
}

/** A host's anti-idle switch, interval, text and Enter, as one draft. */
export function AntiIdleFields({
  value,
  onChange,
}: {
  value: AntiIdleDraft;
  onChange: (value: AntiIdleDraft) => void;
}) {
  const intervalProblem = value.enabled ? antiIdleIntervalProblem(value) : undefined;
  return (
    <Stack spacing={1.5}>
      <FormControlLabel
        control={
          <Switch
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
        }
        label="Type into idle sessions"
      />
      {value.enabled && (
        <>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <TextField
              label="After"
              value={value.intervalSeconds}
              onChange={(event) =>
                onChange({
                  ...value,
                  intervalSeconds: event.target.value.replace(/[^\d]/g, '').slice(0, 4),
                })
              }
              error={!!intervalProblem}
              helperText={intervalProblem ?? 'Without input'}
              sx={{ width: 150, flexShrink: 0 }}
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">s</InputAdornment> },
                htmlInput: { inputMode: 'numeric' },
              }}
            />
            <TextField
              label="Text"
              fullWidth
              value={value.text}
              placeholder={value.enter ? 'Nothing — only press Enter' : undefined}
              onChange={(event) => onChange({ ...value, text: event.target.value })}
              helperText="Typed exactly as entered, spaces included."
              slotProps={{
                inputLabel: { shrink: true },
                input: { sx: { fontFamily: MONO_FONT, fontSize: 13 } },
                htmlInput: { maxLength: ANTI_IDLE_TEXT_MAX_LENGTH, spellCheck: false },
              }}
            />
          </Stack>
          <FormControlLabel
            control={
              <Checkbox
                checked={value.enter}
                onChange={(event) => onChange({ ...value, enter: event.target.checked })}
              />
            }
            label="Press Enter afterwards"
          />
          {value.enter && (
            <Alert severity="warning" variant="outlined">
              Enter also answers whatever the device is asking at that moment, such as a
              confirmation before a reload, and runs a command left half-typed for longer than
              the interval. In a full-screen editor or pager, the text and Enter land there.
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
}
