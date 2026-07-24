import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import type { HostDraft } from './draft.js';

/**
 * Everything ssh_config knows that Muxus doesn't model: free-form option
 * rows (kept verbatim through edits), plus the live preview of the exact
 * block text a save writes — rendered by the server so it can't drift.
 */
export function AdvancedSection({
  draft,
  set,
  preview,
  previewError,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  preview: string;
  previewError: string | null;
}) {
  const update = (i: number, patch: Partial<{ keyword: string; value: string }>) =>
    set({ extras: draft.extras.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  return (
    <Stack spacing={2}>
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">
          Extra ssh_config options written into the block as-is (Compression, ServerAliveInterval, RequestTTY, …).
        </Typography>
        {draft.extras.map((e, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField label="Option" value={e.keyword} onChange={(ev) => update(i, { keyword: ev.target.value })} sx={{ width: 220 }} />
            <TextField label="Value" value={e.value} onChange={(ev) => update(i, { value: ev.target.value })} fullWidth />
            <IconButton size="small" aria-label="Remove option" onClick={() => set({ extras: draft.extras.filter((_, j) => j !== i) })}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Stack>
        ))}
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => set({ extras: [...draft.extras, { keyword: '', value: '' }] })}
          sx={{ alignSelf: 'flex-start' }}
        >
          Add option
        </Button>
      </Stack>

      <Stack spacing={0.75}>
        <Typography variant="body2" color="text.secondary">
          This is written to the config:
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            borderRadius: 1,
            border: 1,
            borderColor: previewError ? 'error.main' : 'divider',
            bgcolor: 'action.hover',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            lineHeight: 1.6,
            overflowX: 'auto',
            minHeight: 72,
            whiteSpace: 'pre',
          }}
        >
          {previewError ?? preview ?? ''}
        </Box>
      </Stack>
    </Stack>
  );
}
