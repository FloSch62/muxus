import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import {
  parsePasteDelay,
  PASTE_DELAY_MAX,
  type PasteDelayKind,
} from '../../terminal/paste-pacing.js';

const LABELS: Record<PasteDelayKind, string> = {
  line: 'Delay after each line',
  char: 'Delay after each character',
};

/**
 * A host's own paste delay in milliseconds. Empty follows the Terminal
 * settings, whose value shows as the placeholder; 0 turns pacing off for
 * this host even when the settings pace every paste.
 */
export function PasteDelayField({
  kind,
  value,
  defaultValue,
  onChange,
  mixed = false,
  helperText,
}: {
  kind: PasteDelayKind;
  value: number | undefined;
  /** The Terminal settings' value, used while this one is empty. */
  defaultValue: number;
  onChange: (value: number | undefined) => void;
  /** Several hosts with different delays. */
  mixed?: boolean;
  helperText?: string;
}) {
  return (
    <TextField
      label={LABELS[kind]}
      type="number"
      value={value ?? ''}
      onChange={(event) => onChange(parsePasteDelay(event.target.value, kind))}
      placeholder={mixed ? 'Multiple values' : `${defaultValue} (Terminal settings)`}
      helperText={helperText}
      fullWidth
      slotProps={{
        inputLabel: { shrink: true },
        input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
        htmlInput: { min: 0, max: PASTE_DELAY_MAX[kind], step: kind === 'line' ? 50 : 1 },
      }}
    />
  );
}
