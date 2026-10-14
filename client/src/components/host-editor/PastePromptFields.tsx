import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  DEFAULT_PASTE_ERROR_PATTERN,
  DEFAULT_PASTE_PROMPT_PATTERN,
  DEFAULT_PASTE_PROMPT_TIMEOUT_MS,
  MAX_PASTE_PATTERN_LENGTH,
  pastePatternProblem,
} from '@muxus/shared';
import { pastePromptTimeoutProblem, type PastePromptWaitDraft } from '../../terminal/paste-prompt.js';

const MONO_FONT = '"JetBrains Mono", monospace';
const PATTERN_INPUT = {
  inputLabel: { shrink: true },
  input: { sx: { fontFamily: MONO_FONT, fontSize: 13 } },
  htmlInput: { maxLength: MAX_PASTE_PATTERN_LENGTH, spellCheck: false },
};

/** A host's prompt waiting for pastes: the switch, both patterns and the timeout. */
export function PastePromptFields({
  value,
  onChange,
}: {
  value: PastePromptWaitDraft;
  onChange: (value: PastePromptWaitDraft) => void;
}) {
  const promptProblem = value.promptPattern ? pastePatternProblem(value.promptPattern) : undefined;
  const errorProblem = value.errorPattern ? pastePatternProblem(value.errorPattern) : undefined;
  const timeoutProblem = pastePromptTimeoutProblem(value.timeoutMs);
  return (
    <Stack spacing={1.5}>
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={value.enabled}
              onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            />
          }
          label="Wait for the prompt after each line"
        />
        <Typography variant="body2" color="textSecondary">
          Sends the next line once the device shows its prompt again, instead of after the line
          delay, and stops the paste at the first line the device rejects. A shell in bracketed
          paste mode, such as bash, gets the delays. Empty fields use the defaults shown.
        </Typography>
      </Box>
      {value.enabled && (
        <>
          <Stack
            direction="row"
            spacing={1.5}
            useFlexGap
            sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
          >
            <TextField
              label="Prompt pattern"
              fullWidth
              value={value.promptPattern}
              placeholder={DEFAULT_PASTE_PROMPT_PATTERN}
              onChange={(event) => onChange({ ...value, promptPattern: event.target.value })}
              error={!!promptProblem}
              helperText={promptProblem ?? 'Regular expression for the line the device waits on.'}
              sx={{ flex: 1, minWidth: 220 }}
              slotProps={PATTERN_INPUT}
            />
            <TextField
              label="Timeout"
              value={value.timeoutMs}
              placeholder={String(DEFAULT_PASTE_PROMPT_TIMEOUT_MS)}
              onChange={(event) =>
                onChange({ ...value, timeoutMs: event.target.value.replace(/[^\d]/g, '').slice(0, 5) })
              }
              error={!!timeoutProblem}
              helperText={timeoutProblem ?? 'Then the line delay applies.'}
              sx={{ width: 170, flexShrink: 0 }}
              slotProps={{
                inputLabel: { shrink: true },
                input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
                htmlInput: { inputMode: 'numeric' },
              }}
            />
          </Stack>
          <TextField
            label="Error pattern"
            fullWidth
            value={value.errorPattern}
            placeholder={DEFAULT_PASTE_ERROR_PATTERN}
            onChange={(event) => onChange({ ...value, errorPattern: event.target.value })}
            error={!!errorProblem}
            helperText={
              errorProblem ?? 'Regular expression for an output line that rejects the line sent.'
            }
            slotProps={PATTERN_INPUT}
          />
        </>
      )}
    </Stack>
  );
}
