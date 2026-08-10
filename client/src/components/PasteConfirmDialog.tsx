import { useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { terminalFontStack, usePrefsStore } from '../state/prefs.js';
import { pasteLineNumberWindow } from '../terminal/paste-line-numbers.js';
import { pasteLineCount } from '../terminal/paste-safety.js';

const EDITOR_PADDING_Y_PX = 8.5;

function updateLineNumberGutter(
  gutter: HTMLPreElement | null,
  lineCount: number,
  scrollTop: number,
  lineHeightPx: number,
) {
  if (!gutter) return;
  const window = pasteLineNumberWindow(lineCount, scrollTop, lineHeightPx);
  if (gutter.textContent !== window.labels) gutter.textContent = window.labels;
  gutter.style.transform = `translateY(${-window.offsetPx}px)`;
}

function measureEditorLineHeight(textArea: HTMLTextAreaElement, fallback: number): number {
  const measured = Number.parseFloat(getComputedStyle(textArea).lineHeight);
  return Number.isFinite(measured) && measured > 0 ? measured : fallback;
}

export function PasteConfirmDialog({
  initialText,
  onCancel,
  onConfirm,
}: {
  initialText: string;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const monoFontSize = usePrefsStore((state) => state.monoFontSize);
  const fontFamily = usePrefsStore((state) => state.fontFamily);
  const lineHeight = usePrefsStore((state) => state.lineHeight);
  const [text, setText] = useState(initialText);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  const lineNumbersRef = useRef<HTMLPreElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const editorFontFamily = terminalFontStack(fontFamily);
  const editorLineHeightPx = monoFontSize * lineHeight;
  const lineHeightRef = useRef(editorLineHeightPx);
  const lineCount = text.length === 0 ? 0 : pasteLineCount(text);
  const visibleLineCount = Math.max(1, lineCount);
  const initialLineNumbers = pasteLineNumberWindow(visibleLineCount, 0).labels;
  const gutterWidth = Math.ceil(
    30 + String(visibleLineCount).length * monoFontSize * 0.65,
  );

  useLayoutEffect(() => {
    const textArea = textAreaRef.current;
    if (textArea) {
      lineHeightRef.current = measureEditorLineHeight(textArea, editorLineHeightPx);
    }
    updateLineNumberGutter(
      lineNumbersRef.current,
      visibleLineCount,
      textArea?.scrollTop ?? 0,
      lineHeightRef.current,
    );
  }, [editorFontFamily, editorLineHeightPx, monoFontSize, visibleLineCount]);

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
                // The gutter itself starts inside the one-pixel input outline.
                pt: `${EDITOR_PADDING_Y_PX - 1}px`,
                pr: 1.25,
                color: 'text.disabled',
                fontFamily: editorFontFamily,
                fontSize: monoFontSize,
                lineHeight,
                textAlign: 'right',
                userSelect: 'none',
                willChange: 'transform',
              }}
            >
              {initialLineNumbers}
            </Box>
          </Box>
          <TextField
            inputRef={textAreaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
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
                style: {
                  fontFamily: editorFontFamily,
                  fontSize: monoFontSize,
                  lineHeight,
                },
                onScroll: (event: UIEvent<HTMLTextAreaElement>) => {
                  lineHeightRef.current = measureEditorLineHeight(
                    event.currentTarget,
                    editorLineHeightPx,
                  );
                  updateLineNumberGutter(
                    lineNumbersRef.current,
                    visibleLineCount,
                    event.currentTarget.scrollTop,
                    lineHeightRef.current,
                  );
                },
              },
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                pl: `${gutterWidth + 12}px`,
                py: `${EDITOR_PADDING_Y_PX}px`,
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
