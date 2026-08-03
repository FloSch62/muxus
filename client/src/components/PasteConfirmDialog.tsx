import { useMemo, useRef, useState, type UIEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { pasteLineCount } from '../terminal/paste-safety.js';

export function PasteConfirmDialog({
  initialText,
  onCancel,
  onConfirm,
}: {
  initialText: string;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  const lineNumbersRef = useRef<HTMLPreElement>(null);
  const lineCount = text.length === 0 ? 0 : pasteLineCount(text);
  const visibleLineCount = Math.max(1, lineCount);
  const lineNumbers = useMemo(
    () => Array.from({ length: visibleLineCount }, (_, index) => index + 1).join('\n'),
    [visibleLineCount],
  );
  const gutterWidth = 30 + String(visibleLineCount).length * 8;

  const syncLineNumberScroll = (scrollTop: number) => {
    if (lineNumbersRef.current) {
      lineNumbersRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      maxWidth="md"
      fullWidth
      slotProps={{ transition: { onEntered: () => pasteButtonRef.current?.focus() } }}
    >
      <DialogTitle>
        {lineCount === 0 ? 'Nothing to paste' : `Paste ${lineCount} lines into the terminal?`}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Multiple lines may run several commands immediately. Review or edit the content before sending it.
        </Typography>
        <Box sx={{ position: 'relative' }}>
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              zIndex: 1,
              top: 1,
              bottom: 1,
              left: 1,
              width: gutterWidth,
              overflow: 'hidden',
              pointerEvents: 'none',
              bgcolor: 'action.hover',
              borderRight: 1,
              borderColor: 'divider',
              borderRadius: '3px 0 0 3px',
            }}
          >
            <Box
              ref={lineNumbersRef}
              component="pre"
              data-testid="paste-line-numbers"
              sx={{
                position: 'absolute',
                top: 0,
                right: 0,
                m: 0,
                pt: '16.5px',
                pr: 1.25,
                color: 'text.disabled',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                lineHeight: 1.5,
                textAlign: 'right',
                userSelect: 'none',
                willChange: 'transform',
              }}
            >
              {lineNumbers}
            </Box>
          </Box>
          <TextField
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              syncLineNumberScroll(event.currentTarget.scrollTop);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
              event.preventDefault();
              if (text.length > 0) onConfirm(text);
            }}
            multiline
            minRows={8}
            maxRows={18}
            fullWidth
            slotProps={{
              htmlInput: {
                'aria-label': 'Content to paste',
                spellCheck: false,
                wrap: 'off',
                onScroll: (event: UIEvent<HTMLTextAreaElement>) =>
                  syncLineNumberScroll(event.currentTarget.scrollTop),
              },
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                pl: `${gutterWidth + 12}px`,
              },
              '& .MuiInputBase-inputMultiline': {
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                lineHeight: 1.5,
              },
            }}
          />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Enter adds a new line while editing. Press Ctrl+Enter or ⌘Enter to paste.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          ref={pasteButtonRef}
          variant="contained"
          color="warning"
          disabled={text.length === 0}
          onClick={() => onConfirm(text)}
        >
          Paste
        </Button>
      </DialogActions>
    </Dialog>
  );
}
