import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import {
  cancelPaste,
  pasteProgressLabel,
  pasteProgressPercent,
  usePasteProgressStore,
} from '../state/paste-progress.js';

/** A ring on the tab while a paced paste runs; clicking it cancels the paste. */
export function TabPasteProgress({ tabId }: { tabId: string }) {
  const progress = usePasteProgressStore((state) => state.byTab[tabId]);
  if (!progress) return null;
  return (
    <Tooltip title={`${pasteProgressLabel(progress)}. Click to cancel.`}>
      <IconButton
        size="small"
        aria-label="Cancel paste"
        onClick={(event) => {
          event.stopPropagation();
          cancelPaste(tabId);
        }}
        sx={{ p: 0.25, flexShrink: 0 }}
      >
        <CircularProgress
          variant="determinate"
          value={pasteProgressPercent(progress)}
          size={13}
          thickness={6}
          color="warning"
        />
      </IconButton>
    </Tooltip>
  );
}

/** Progress and a cancel button over the terminal while a paced paste runs. */
export function PasteProgressOverlay({ tabId }: { tabId: string }) {
  const progress = usePasteProgressStore((state) => state.byTab[tabId]);
  if (!progress) return null;
  return (
    <Paper
      elevation={8}
      sx={{
        position: 'absolute',
        zIndex: 6,
        right: 13,
        bottom: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        pl: 1.5,
        pr: 0.75,
        py: 0.75,
        border: 1,
        borderColor: 'divider',
      }}
    >
      <ContentPasteIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
      <Box sx={{ width: 170 }}>
        <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
          {pasteProgressLabel(progress)}
        </Typography>
        <LinearProgress
          variant="determinate"
          color="warning"
          value={pasteProgressPercent(progress)}
          sx={{ borderRadius: 1 }}
        />
      </Box>
      <Button size="small" onClick={() => cancelPaste(tabId)}>
        Cancel
      </Button>
    </Paper>
  );
}
