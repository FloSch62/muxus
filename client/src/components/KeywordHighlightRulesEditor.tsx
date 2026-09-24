import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import type { KeywordHighlightRule } from '@muxus/shared';
import { newPreferenceId } from '../command-buttons.js';
import {
  keywordHighlightRulesToJson,
  parseKeywordHighlightRulesJson,
} from '../highlight-profiles.js';
import { keywordPatternError } from '../terminal/keyword-highlighting.js';

const MONO_FONT = '"JetBrains Mono", monospace';
// Matches a small outlined TextField so every control in a rule row lines up.
const ROW_HEIGHT = 40;

const DEFAULT_RULE: Omit<KeywordHighlightRule, 'id'> = {
  keyword: 'ERROR',
  foreground: '#ffffff',
  background: '#b91c1c',
  caseSensitive: false,
  wholeWord: true,
};

export function KeywordHighlightRulesEditor({
  rules,
  onChange,
  emptyMessage = 'No keyword rules yet.',
}: {
  rules: KeywordHighlightRule[];
  onChange: (rules: KeywordHighlightRule[]) => void;
  emptyMessage?: string;
}) {
  // Non-null while the list is being edited as JSON text.
  const [json, setJson] = useState<string | null>(null);

  if (json !== null) {
    return (
      <RulesJsonEditor
        text={json}
        onTextChange={setJson}
        onApply={(text) => {
          onChange(parseKeywordHighlightRulesJson(text, rules));
          setJson(null);
        }}
        onCancel={() => setJson(null)}
      />
    );
  }

  const update = (id: string, patch: Partial<KeywordHighlightRule>) => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <Stack spacing={0.75}>
      {rules.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyMessage}
        </Typography>
      ) : null}
      {rules.map((rule, index) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          isFirst={index === 0}
          isLast={index === rules.length - 1}
          onUpdate={(patch) => update(rule.id, patch)}
          onMove={(offset) => move(index, offset)}
          onDelete={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}
        />
      ))}
      <Stack direction="row" spacing={1} sx={{ pt: 0.5 }}>
        <Button
          startIcon={<AddIcon />}
          onClick={() =>
            onChange([...rules, { ...DEFAULT_RULE, id: newPreferenceId('highlight') }])
          }
        >
          Add rule
        </Button>
        <Button
          startIcon={<DataObjectOutlinedIcon />}
          onClick={() => setJson(keywordHighlightRulesToJson(rules))}
        >
          Edit as JSON
        </Button>
      </Stack>
    </Stack>
  );
}

function RuleRow({
  rule,
  isFirst,
  isLast,
  onUpdate,
  onMove,
  onDelete,
}: {
  rule: KeywordHighlightRule;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (patch: Partial<KeywordHighlightRule>) => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const patternError = keywordPatternError(rule);
  const label = rule.name || rule.keyword || 'rule';
  const patternLabel = rule.regex ? 'Regular expression' : 'Keyword';

  return (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      sx={{ alignItems: 'flex-start', flexWrap: { xs: 'wrap', sm: 'nowrap' } }}
    >
      <RuleStyleButton rule={rule} onUpdate={onUpdate} />
      <TextField
        size="small"
        placeholder="Name (optional)"
        value={rule.name ?? ''}
        onChange={(event) => onUpdate({ name: event.target.value || undefined })}
        sx={{ width: 170, flexShrink: 0 }}
        slotProps={{ htmlInput: { maxLength: 100, 'aria-label': 'Rule name' } }}
      />
      <TextField
        size="small"
        placeholder={patternLabel}
        value={rule.keyword}
        error={!rule.keyword || !!patternError}
        helperText={patternError}
        onChange={(event) => onUpdate({ keyword: event.target.value })}
        sx={{ flex: 1, minWidth: 160 }}
        slotProps={{
          input: rule.regex ? { sx: { fontFamily: MONO_FONT, fontSize: 13 } } : undefined,
          htmlInput: { maxLength: 500, spellCheck: false, 'aria-label': patternLabel },
        }}
      />
      <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
        <FlagToggle
          label="Match case"
          selected={rule.caseSensitive}
          onChange={(caseSensitive) => onUpdate({ caseSensitive })}
        >
          Aa
        </FlagToggle>
        <FlagToggle
          label="Whole word"
          selected={rule.wholeWord}
          onChange={(wholeWord) => onUpdate({ wholeWord })}
        >
          <Box component="span" sx={{ textDecoration: 'underline' }}>
            ab
          </Box>
        </FlagToggle>
        <FlagToggle
          label="Regular expression"
          selected={!!rule.regex}
          onChange={(regex) => onUpdate({ regex: regex || undefined })}
        >
          .*
        </FlagToggle>
      </Stack>
      <Stack direction="row" sx={{ flexShrink: 0, height: ROW_HEIGHT, alignItems: 'center' }}>
        <Tooltip title="Move up">
          <span>
            <IconButton
              aria-label={`Move ${label} up`}
              size="small"
              disabled={isFirst}
              onClick={() => onMove(-1)}
            >
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Move down">
          <span>
            <IconButton
              aria-label={`Move ${label} down`}
              size="small"
              disabled={isLast}
              onClick={() => onMove(1)}
            >
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Delete rule">
          <IconButton
            aria-label={`Delete ${label} rule`}
            size="small"
            color="error"
            onClick={onDelete}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

/** A VS Code–style search option: a monospace glyph with its name as tooltip. */
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

/** A preview of the rule's colors that opens its color settings. */
function RuleStyleButton({
  rule,
  onUpdate,
}: {
  rule: KeywordHighlightRule;
  onUpdate: (patch: Partial<KeywordHighlightRule>) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title="Colors">
        <Box
          component="button"
          type="button"
          aria-label={`Colors for ${rule.name || rule.keyword || 'rule'}`}
          aria-haspopup="dialog"
          onClick={(event: React.MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}
          sx={{
            width: 44,
            height: ROW_HEIGHT,
            flexShrink: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'background.default',
            p: 0,
            '&:hover, &:focus-visible': { borderColor: 'text.primary' },
          }}
        >
          <Box
            component="span"
            sx={{
              px: 0.5,
              borderRadius: 0.5,
              fontFamily: MONO_FONT,
              fontSize: 13,
              fontWeight: 600,
              color: rule.foreground,
              bgcolor: rule.background ?? 'transparent',
            }}
          >
            Ab
          </Box>
        </Box>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Stack spacing={1.25} sx={{ p: 2 }}>
          <ColorInput
            label="Text"
            value={rule.foreground}
            onChange={(foreground) => onUpdate({ foreground })}
          />
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <FormControlLabel
              sx={{ mr: 0 }}
              control={
                <Switch
                  size="small"
                  checked={rule.background !== undefined}
                  onChange={(event) =>
                    onUpdate({ background: event.target.checked ? '#713f12' : undefined })
                  }
                />
              }
              label={<Typography variant="body2">Background</Typography>}
            />
            {rule.background ? (
              <ColorInput
                label="Fill"
                value={rule.background}
                onChange={(background) => onUpdate({ background })}
              />
            ) : null}
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}

function RulesJsonEditor({
  text,
  onTextChange,
  onApply,
  onCancel,
}: {
  text: string;
  onTextChange: (text: string) => void;
  /** Throws when the text is not a valid rule list. */
  onApply: (text: string) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string>();

  const apply = () => {
    try {
      onApply(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Stack spacing={1}>
      <TextField
        multiline
        fullWidth
        minRows={8}
        maxRows={24}
        value={text}
        error={!!error}
        onChange={(event) => {
          onTextChange(event.target.value);
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            apply();
          }
        }}
        slotProps={{
          input: { sx: { fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: 1.5 } },
          htmlInput: { spellCheck: false, 'aria-label': 'Rules as JSON' },
        }}
      />
      {error ? (
        <Alert severity="error" variant="outlined">
          {error}
        </Alert>
      ) : (
        <Typography variant="caption" color="text.secondary">
          An array of rules. Each needs a keyword and a foreground color; name, background,
          regex, caseSensitive and wholeWord are optional. Backslashes in a regex are
          written twice in JSON, as in \\d+.
        </Typography>
      )}
      <Stack direction="row" spacing={1}>
        <Button variant="contained" onClick={apply}>
          Apply
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Stack>
    </Stack>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 32 }}>
        {label}
      </Typography>
      <Box
        component="input"
        type="color"
        aria-label={`${label} color`}
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
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
    </Stack>
  );
}
