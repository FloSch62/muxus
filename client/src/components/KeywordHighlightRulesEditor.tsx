import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import type { KeywordHighlightRule } from '@muxus/shared';
import { newPreferenceId } from '../command-buttons.js';

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
    <Stack spacing={1.25}>
      {rules.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyMessage}
        </Typography>
      ) : null}
      {rules.map((rule, index) => (
        <Paper key={rule.id} variant="outlined" sx={{ p: 1.5 }}>
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField
                label="Keyword"
                value={rule.keyword}
                error={!rule.keyword}
                onChange={(event) => update(rule.id, { keyword: event.target.value })}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
              <Tooltip title="Move up">
                <span>
                  <IconButton
                    aria-label={`Move ${rule.keyword || 'keyword'} up`}
                    size="small"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Move down">
                <span>
                  <IconButton
                    aria-label={`Move ${rule.keyword || 'keyword'} down`}
                    size="small"
                    disabled={index === rules.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Delete rule">
                <IconButton
                  aria-label={`Delete ${rule.keyword || 'keyword'} rule`}
                  size="small"
                  color="error"
                  onClick={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <ColorInput
                label="Text"
                value={rule.foreground}
                onChange={(foreground) => update(rule.id, { foreground })}
              />
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={rule.background !== undefined}
                    onChange={(event) =>
                      update(rule.id, {
                        background: event.target.checked ? '#713f12' : undefined,
                      })
                    }
                  />
                }
                label={<Typography variant="body2">Background</Typography>}
              />
              {rule.background ? (
                <ColorInput
                  label="Fill"
                  value={rule.background}
                  onChange={(background) => update(rule.id, { background })}
                />
              ) : null}
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={rule.caseSensitive}
                    onChange={(event) => update(rule.id, { caseSensitive: event.target.checked })}
                  />
                }
                label={<Typography variant="body2">Match case</Typography>}
              />
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={rule.wholeWord}
                    onChange={(event) => update(rule.id, { wholeWord: event.target.checked })}
                  />
                }
                label={<Typography variant="body2">Whole word</Typography>}
              />
            </Stack>
          </Stack>
        </Paper>
      ))}
      <Box>
        <Button
          startIcon={<AddIcon />}
          onClick={() =>
            onChange([
              ...rules,
              { ...DEFAULT_RULE, id: newPreferenceId('highlight') },
            ])
          }
        >
          Add keyword
        </Button>
      </Box>
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
      <Typography variant="caption" color="text.secondary">
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
