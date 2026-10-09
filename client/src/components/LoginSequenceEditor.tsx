import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import KeyboardReturnIcon from '@mui/icons-material/KeyboardReturn';
import {
  LOGIN_SEQUENCE_MAX_STEPS,
  LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS,
  LOGIN_SEQUENCE_TEXT_MAX_LENGTH,
  type LoginSequence,
  type LoginSequenceStep,
} from '@muxus/shared';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import {
  changeLoginStepKind,
  loginStepSummary,
  moveLoginStep,
  newLoginStep,
  waitPatternError,
  type LoginSequenceDraft,
  type LoginSequenceMode,
  type LoginStepKind,
} from '../login-sequence.js';
import { findVaultSecret } from '../vault-secrets.js';
import { VaultSecretField } from './VaultSecretField.js';

const MONO_FONT = '"JetBrains Mono", monospace';
// A small outlined TextField, so every control in a step row lines up.
const ROW_HEIGHT = 40;

const STEP_KINDS: ReadonlyArray<{ value: LoginStepKind; label: string }> = [
  { value: 'wait', label: 'Wait for' },
  { value: 'send', label: 'Send text' },
  { value: 'secret', label: 'Send secret' },
];

/**
 * Edits a login sequence: where it comes from (inherited, none or its own
 * steps) and the wait/send rows themselves, which can be reordered. Shared by
 * the host editors, the bulk editor and the folder dialog.
 */
export function LoginSequenceEditor({
  value,
  onChange,
  inherited,
  inheritLabel,
  inheritEmptyText,
}: {
  value: LoginSequenceDraft;
  onChange: (value: LoginSequenceDraft) => void;
  /** What inheriting currently resolves to, previewed under the mode. */
  inherited?: { sequence: LoginSequence; folder: string };
  inheritLabel: string;
  /** Said under the mode when inheriting resolves to nothing. */
  inheritEmptyText: string;
}) {
  const setMode = (mode: LoginSequenceMode) => {
    // A first switch to custom starts with the most common opening step.
    const steps = mode === 'custom' && value.steps.length === 0 ? [newLoginStep('wait')] : value.steps;
    onChange({ mode, steps });
  };
  const setSteps = (steps: LoginSequenceStep[]) => onChange({ ...value, steps });

  return (
    <Stack spacing={2}>
      <TextField
        select
        fullWidth
        label="Login sequence"
        value={value.mode}
        onChange={(event) => setMode(event.target.value as LoginSequenceMode)}
      >
        <MenuItem value="inherit">{inheritLabel}</MenuItem>
        <MenuItem value="none">No login sequence</MenuItem>
        <MenuItem value="custom">Run these steps</MenuItem>
      </TextField>
      {value.mode === 'inherit' ? (
        inherited ? (
          <InheritedSteps inherited={inherited} />
        ) : (
          <Typography variant="body2" color="textSecondary">
            {inheritEmptyText}
          </Typography>
        )
      ) : null}
      {value.mode === 'custom' ? <StepList steps={value.steps} onChange={setSteps} /> : null}
    </Stack>
  );
}

function InheritedSteps({ inherited }: { inherited: { sequence: LoginSequence; folder: string } }) {
  const { data: vault } = usePasswordVaultStatus();
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1.25 }}>
      <Typography variant="caption" color="textSecondary">
        From the folder “{inherited.folder}”
      </Typography>
      <Box component="ol" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
        {inherited.sequence.steps.map((step) => (
          <Typography component="li" variant="body2" key={step.id} sx={{ overflowWrap: 'anywhere' }}>
            {loginStepSummary(
              step,
              step.kind === 'secret' ? findVaultSecret(vault, step.secretId)?.name : undefined,
            )}
          </Typography>
        ))}
      </Box>
    </Paper>
  );
}

function StepList({
  steps,
  onChange,
}: {
  steps: LoginSequenceStep[];
  onChange: (steps: LoginSequenceStep[]) => void;
}) {
  const update = (index: number, step: LoginSequenceStep) =>
    onChange(steps.map((candidate, at) => (at === index ? step : candidate)));
  const full = steps.length >= LOGIN_SEQUENCE_MAX_STEPS;

  return (
    <Stack spacing={1}>
      {steps.map((step, index) => (
        <StepRow
          key={step.id}
          step={step}
          number={index + 1}
          isFirst={index === 0}
          isLast={index === steps.length - 1}
          onChange={(next) => update(index, next)}
          onMove={(offset) => onChange(moveLoginStep(steps, index, offset))}
          onDelete={() => onChange(steps.filter((_candidate, at) => at !== index))}
        />
      ))}
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.5 }}>
        {STEP_KINDS.map((kind) => (
          <Button
            key={kind.value}
            startIcon={<AddIcon />}
            disabled={full}
            onClick={() => onChange([...steps, newLoginStep(kind.value)])}
          >
            {kind.label}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}

function StepRow({
  step,
  number,
  isFirst,
  isLast,
  onChange,
  onMove,
  onDelete,
}: {
  step: LoginSequenceStep;
  number: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (step: LoginSequenceStep) => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
    >
      <Typography
        variant="body2"
        color="textSecondary"
        sx={{ width: 18, lineHeight: `${ROW_HEIGHT}px`, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        {number}
      </Typography>
      <TextField
        select
        size="small"
        value={step.kind}
        onChange={(event) => onChange(changeLoginStepKind(step, event.target.value as LoginStepKind))}
        sx={{ width: 140, flexShrink: 0 }}
        slotProps={{ htmlInput: { 'aria-label': `Step ${number} action` } }}
      >
        {STEP_KINDS.map((kind) => (
          <MenuItem key={kind.value} value={kind.value}>
            {kind.label}
          </MenuItem>
        ))}
      </TextField>
      <Box sx={{ flex: 1, minWidth: 180 }}>
        <StepFields step={step} number={number} onChange={onChange} />
      </Box>
      <Stack direction="row" sx={{ flexShrink: 0, height: ROW_HEIGHT, alignItems: 'center', ml: 'auto' }}>
        <Tooltip title="Move up">
          <span>
            <IconButton aria-label={`Move step ${number} up`} size="small" disabled={isFirst} onClick={() => onMove(-1)}>
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Move down">
          <span>
            <IconButton aria-label={`Move step ${number} down`} size="small" disabled={isLast} onClick={() => onMove(1)}>
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Delete step">
          <IconButton aria-label={`Delete step ${number}`} size="small" color="error" onClick={onDelete}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

function StepFields({
  step,
  number,
  onChange,
}: {
  step: LoginSequenceStep;
  number: number;
  onChange: (step: LoginSequenceStep) => void;
}) {
  if (step.kind === 'wait') {
    const error = step.regex && step.pattern ? waitPatternError(step.pattern) : undefined;
    return (
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'flex-start' }}>
        <TextField
          size="small"
          fullWidth
          value={step.pattern}
          placeholder={step.regex ? '[>#]\\s*$' : 'Password:'}
          error={!!error}
          helperText={error}
          onChange={(event) => onChange({ ...step, pattern: event.target.value })}
          slotProps={{
            input: { sx: { fontFamily: MONO_FONT, fontSize: 13 } },
            htmlInput: {
              maxLength: LOGIN_SEQUENCE_TEXT_MAX_LENGTH,
              spellCheck: false,
              'aria-label': step.regex ? `Step ${number} pattern` : `Step ${number} text to wait for`,
            },
          }}
        />
        <FlagToggle
          label="Regular expression"
          selected={!!step.regex}
          onChange={(regex) => onChange({ ...step, regex: regex || undefined })}
        >
          .*
        </FlagToggle>
        <Tooltip title="Stop the sequence if nothing matches within this time">
          <TextField
            size="small"
            value={String(step.timeoutSeconds)}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^\d]/g, '').slice(0, 4);
              onChange({ ...step, timeoutSeconds: digits ? Number(digits) : 0 });
            }}
            error={step.timeoutSeconds < 1 || step.timeoutSeconds > LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS}
            sx={{ width: 84, flexShrink: 0 }}
            slotProps={{
              input: { endAdornment: <InputAdornment position="end">s</InputAdornment> },
              htmlInput: { inputMode: 'numeric', 'aria-label': `Step ${number} timeout in seconds` },
            }}
          />
        </Tooltip>
      </Stack>
    );
  }
  const enter = (
    <FlagToggle
      label="Press Enter afterwards"
      selected={step.enter}
      onChange={(value) => onChange({ ...step, enter: value })}
    >
      <KeyboardReturnIcon sx={{ fontSize: 17 }} />
    </FlagToggle>
  );
  if (step.kind === 'send') {
    return (
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'flex-start' }}>
        <TextField
          size="small"
          fullWidth
          value={step.text}
          placeholder={step.enter ? 'Nothing — only press Enter' : 'enable'}
          onChange={(event) => onChange({ ...step, text: event.target.value })}
          slotProps={{
            input: { sx: { fontFamily: MONO_FONT, fontSize: 13 } },
            htmlInput: {
              maxLength: LOGIN_SEQUENCE_TEXT_MAX_LENGTH,
              spellCheck: false,
              'aria-label': `Step ${number} text to send`,
            },
          }}
        />
        {enter}
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'flex-start' }}>
      <VaultSecretField
        size="small"
        label="Secret"
        value={step.secretId || undefined}
        onChange={(secretId) => onChange({ ...step, secretId })}
        sx={{ flex: 1, minWidth: 0 }}
      />
      {enter}
    </Stack>
  );
}

/** A compact on/off option with its name as tooltip, as in the highlighting rules. */
function FlagToggle({
  label,
  selected,
  onChange,
  children,
}: {
  label: string;
  selected: boolean;
  onChange: (selected: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={label}>
      <ToggleButton
        value={label}
        size="small"
        aria-label={label}
        selected={selected}
        onChange={() => onChange(!selected)}
        sx={{
          width: 34,
          height: ROW_HEIGHT,
          p: 0,
          flexShrink: 0,
          fontFamily: MONO_FONT,
          fontSize: 13,
          textTransform: 'none',
        }}
      >
        {children}
      </ToggleButton>
    </Tooltip>
  );
}
