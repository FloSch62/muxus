import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { SessionLoggingPolicyInput } from '@muxus/shared';
import type { HostSessionLoggingDraft } from '../session-logging-policy.js';

export function SessionLoggingPolicyFields({
  value,
  onChange,
  allowInherit = false,
}: {
  value: HostSessionLoggingDraft;
  onChange: (patch: Partial<HostSessionLoggingDraft>) => void;
  allowInherit?: boolean;
}) {
  const disabled = !value.loaded || (allowInherit && value.inherit);

  return (
    <Stack spacing={2.25}>
      {allowInherit ? (
        <FormControlLabel
          control={
            <Switch
              checked={value.inherit}
              disabled={!value.loaded}
              onChange={(event) => onChange({ inherit: event.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Use default session logging settings</Typography>
              <Typography variant="caption" color="text.secondary">
                {value.inherit
                  ? `Inherited: logging ${value.enabled ? 'enabled' : 'disabled'}.`
                  : 'This host has its own logging and retention policy.'}
              </Typography>
            </Box>
          }
        />
      ) : null}

      <FormControlLabel
        control={
          <Switch
            checked={value.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
        }
        label={
          <Box>
            <Typography variant="body2">Log terminal sessions</Typography>
            <Typography variant="caption" color="text.secondary">
              Store timestamped raw activity and a searchable normalized transcript.
            </Typography>
          </Box>
        }
      />

      <Tooltip title="When disabled, client input bytes are never persisted. Commands echoed by the remote shell are still output.">
        <FormControlLabel
          control={
            <Switch
              checked={value.captureInput}
              disabled={disabled || !value.enabled}
              onChange={(event) => onChange({ captureInput: event.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Record terminal input</Typography>
              <Typography variant="caption" color="text.secondary">
                Off is safer: typed commands may contain passwords or tokens.
              </Typography>
            </Box>
          }
        />
      </Tooltip>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          label="Rotate part at"
          type="number"
          value={Math.round(value.maxPartBytes / 1024 / 1024)}
          disabled={disabled || !value.enabled}
          onChange={(event) =>
            onChange({
              maxPartBytes:
                clampInteger(Number(event.target.value), 1, 1024) * 1024 * 1024,
            })
          }
          slotProps={{
            htmlInput: { min: 1, max: 1024 },
            input: { endAdornment: <Typography color="text.secondary">MiB</Typography> },
          }}
          sx={{ width: { sm: 190 } }}
        />
        <TextField
          label="Retain newest parts"
          type="number"
          value={value.maxParts}
          disabled={disabled || !value.enabled}
          onChange={(event) =>
            onChange({
              maxParts: clampInteger(Number(event.target.value), 1, 1000),
            })
          }
          slotProps={{ htmlInput: { min: 1, max: 1000 } }}
          sx={{ width: { sm: 190 } }}
        />
      </Stack>

      {value.enabled && !disabled ? (
        <Typography variant="caption" color="text.secondary">
          Maximum retained raw data per session: approximately{' '}
          {formatRetention(value)}.
        </Typography>
      ) : null}
    </Stack>
  );
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatRetention(policy: SessionLoggingPolicyInput): string {
  const bytes = policy.maxPartBytes * policy.maxParts;
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
