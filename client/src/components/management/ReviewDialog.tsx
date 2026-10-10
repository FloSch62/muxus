import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { DiffViewer, type CodeLanguage } from './CodeEditor.js';

export interface ReviewSection {
  label: string;
  original: string;
  modified: string;
  language: CodeLanguage;
  /** Shown above the diff, e.g. "Does not exist yet". */
  note?: string;
}

/** Lines added and removed, for the summary chips. */
export function lineDelta(original: string, modified: string): { added: number; removed: number } {
  const before = original ? original.split('\n') : [];
  const after = modified ? modified.split('\n') : [];
  // Longest common subsequence on lines; configs are small enough for O(n·m) in the common case.
  if (before.length * after.length > 4_000_000) {
    const beforeSet = new Map<string, number>();
    for (const line of before) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of after) {
      const count = beforeSet.get(line) ?? 0;
      if (count > 0) {
        common++;
        beforeSet.set(line, count - 1);
      }
    }
    return { added: after.length - common, removed: before.length - common };
  }
  let previous = new Uint32Array(after.length + 1);
  let current = new Uint32Array(after.length + 1);
  for (let i = 1; i <= before.length; i++) {
    for (let j = 1; j <= after.length; j++) {
      current[j] = before[i - 1] === after[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  const common = previous[after.length]!;
  return { added: after.length - common, removed: before.length - common };
}

/**
 * Shows what a change will do before it is sent: one diff per change, with
 * a count of lines added and removed. Nothing is applied until the user
 * confirms.
 */
export function ReviewDialog({
  open,
  title,
  description,
  sections,
  loading,
  error,
  applyLabel,
  applyColor = 'primary',
  extraActions,
  onApply,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  sections: ReviewSection[];
  loading?: boolean;
  error?: string;
  applyLabel?: string;
  applyColor?: 'primary' | 'error' | 'success';
  extraActions?: ReactNode;
  onApply?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(0);
  useEffect(() => {
    if (open) setTab(0);
  }, [open]);
  const deltas = useMemo(() => sections.map((section) => lineDelta(section.original, section.modified)), [sections]);
  const unchanged = !loading && sections.length > 0 && deltas.every((delta) => delta.added === 0 && delta.removed === 0);
  const active = sections[Math.min(tab, sections.length - 1)];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      slotProps={{ paper: { sx: { height: 'min(780px, 90vh)' } } }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && onApply && !loading && !error) {
          event.preventDefault();
          onApply();
        }
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: 0 }}>
        {description && (
          <Typography variant="body2" color="textSecondary">
            {description}
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {loading ? (
          <Stack spacing={1} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="textSecondary">
              Reading the current configuration …
            </Typography>
          </Stack>
        ) : (
          sections.length > 0 && (
            <>
              {sections.length > 1 && (
                <Tabs
                  value={Math.min(tab, sections.length - 1)}
                  onChange={(_event, value: number) => setTab(value)}
                  variant="scrollable"
                  sx={{ minHeight: 36, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 36, textTransform: 'none' } }}
                >
                  {sections.map((section, index) => (
                    <Tab
                      key={section.label}
                      value={index}
                      label={
                        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                          <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>
                            {section.label}
                          </Box>
                          <DeltaChips delta={deltas[index]!} />
                        </Stack>
                      }
                    />
                  ))}
                </Tabs>
              )}
              {active && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  {sections.length === 1 && (
                    <Typography variant="body2" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 }}>
                      {active.label}
                    </Typography>
                  )}
                  {sections.length === 1 && <DeltaChips delta={deltas[0]!} />}
                  {active.note && (
                    <Typography variant="caption" color="textSecondary">
                      {active.note}
                    </Typography>
                  )}
                </Stack>
              )}
              {unchanged && <Alert severity="info">Nothing changes: the device already has this configuration.</Alert>}
              {active && (
                <Box sx={{ flex: 1, minHeight: 200 }}>
                  <DiffViewer
                    key={tab}
                    original={active.original}
                    modified={active.modified}
                    language={active.language}
                  />
                </Box>
              )}
            </>
          )
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {extraActions}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>{onApply ? 'Cancel' : 'Close'}</Button>
        {onApply && (
          <Button variant="contained" color={applyColor} disabled={loading || !!error} onClick={onApply}>
            {applyLabel ?? 'Apply'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function DeltaChips({ delta }: { delta: { added: number; removed: number } }) {
  const sx = { height: 18, fontSize: 10.5, '& .MuiChip-label': { px: 0.6 } };
  return (
    <>
      <Chip size="small" label={`+${delta.added}`} color="success" variant="outlined" sx={sx} />
      <Chip size="small" label={`−${delta.removed}`} color="error" variant="outlined" sx={sx} />
    </>
  );
}
