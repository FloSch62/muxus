import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { pasteLineCount } from '../terminal/paste-safety.js';

const MAX_PREVIEW_LINES = 12;

export function PasteConfirmDialog({
  text,
  onCancel,
  onConfirm,
}: {
  text: string | null;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const lines = text?.split(/\r\n|\r|\n/) ?? [];
  const lineCount = text === null ? 0 : pasteLineCount(text);
  const preview = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
  const hidden = Math.max(0, lines.length - MAX_PREVIEW_LINES);

  return (
    <Dialog open={text !== null} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Paste {lineCount} lines into the terminal?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Multiple lines may run several commands immediately. Review the content before sending it.
        </Typography>
        <Typography
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            maxHeight: 280,
            overflow: 'auto',
            borderRadius: 1,
            bgcolor: 'action.hover',
            border: 1,
            borderColor: 'divider',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {preview}
          {hidden > 0 ? `\n… ${hidden} more line${hidden === 1 ? '' : 's'}` : ''}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="contained"
          color="warning"
          onClick={() => {
            if (text !== null) onConfirm(text);
          }}
        >
          Paste
        </Button>
      </DialogActions>
    </Dialog>
  );
}
