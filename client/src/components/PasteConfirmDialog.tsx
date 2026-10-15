import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  pastePacingDurationMs,
  preparePasteText,
  type PastePacing,
} from '@muxus/shared';
import { terminalFontStack, usePrefsStore } from '../state/prefs.js';
import { pasteLineNumberWindow } from '../terminal/paste-line-numbers.js';
import {
  formatPasteDuration,
  parsePasteDelay,
  PASTE_DELAY_MAX,
} from '../terminal/paste-pacing.js';
import {
  flagPasteCharacters,
  pasteLineCount,
  replaceFlaggedCharacters,
  type FlaggedPasteCharacter,
} from '../terminal/paste-safety.js';

const EDITOR_PADDING_Y_PX = 8.5;
const LISTED_POSITIONS = 3;

/** One row per distinct character, with where it occurs. */
function flaggedRows(flagged: readonly FlaggedPasteCharacter[]) {
  const groups = new Map<string, FlaggedPasteCharacter[]>();
  for (const entry of flagged) {
    const group = groups.get(entry.char);
    if (group) group.push(entry);
    else groups.set(entry.char, [entry]);
  }
  return [...groups.values()].map((entries) => {
    const { char, name, ascii } = entries[0]!;
    const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    const positions = entries
      .slice(0, LISTED_POSITIONS)
      .map(({ line, column }) => `line ${line}, column ${column}`)
      .join('; ');
    const more = entries.length - LISTED_POSITIONS;
    return {
      char,
      label: `${name} (U+${code})`,
      ascii,
      where: more > 0 ? `${positions} and ${more} more` : positions,
    };
  });
}

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

/** What the pace means for this paste, or how to slow it down. */
function pacingNote(text: string, pacing: PastePacing, mirrored: number): string {
  const note = pacing.prompt
    ? 'Each line waits for the prompt, and the paste stops at the first line the device rejects.'
    : pacing.lineDelayMs === 0 && pacing.charDelayMs === 0
      ? 'Sent all at once. A line delay paces it for consoles that drop input.'
      : `Takes ${formatPasteDuration(
          pastePacingDurationMs(preparePasteText(text, false), pacing),
        )}${pacing.charDelayMs > 0 ? `, with ${pacing.charDelayMs} ms after each character` : ''}.`;
  return mirrored > 0
    ? `${note} Mirrored terminals paste at their own host's pace.`
    : note;
}

export function PasteConfirmDialog({
  initialText,
  pacing,
  mirrored = 0,
  onCancel,
  onConfirm,
}: {
  initialText: string;
  /** The host's pacing; the line delay can be changed for this paste. */
  pacing: PastePacing;
  /** Other terminals the paste is mirrored into under multi-execution. */
  mirrored?: number;
  onCancel: () => void;
  onConfirm: (text: string, lineDelayMs: number) => void;
}) {
  const monoFontSize = usePrefsStore((state) => state.monoFontSize);
  const fontFamily = usePrefsStore((state) => state.fontFamily);
  const lineHeight = usePrefsStore((state) => state.lineHeight);
  const [text, setText] = useState(initialText);
  const [replacedCount, setReplacedCount] = useState(0);
  const flagged = useMemo(() => flagPasteCharacters(text), [text]);
  const [lineDelay, setLineDelay] = useState(String(pacing.lineDelayMs));
  const lineDelayMs = parsePasteDelay(lineDelay, 'line') ?? 0;
  const confirm = () => {
    if (text.length > 0) onConfirm(text, lineDelayMs);
  };
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
        {lineCount === 0
          ? 'Nothing to paste'
          : `Paste ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} into the terminal?`}
      </DialogTitle>
      <DialogContent>
        {lineCount !== 1 ? (
          <Typography variant="body2" color="textSecondary" sx={{ mb: 1.5 }}>
            Multiple lines may run several commands immediately. Review or edit the content before sending it.
          </Typography>
        ) : null}
        {flagged.length > 0 ? (
          <Alert
            severity="warning"
            sx={{ mb: 1.5 }}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  setText(replaceFlaggedCharacters(text, flagged));
                  setReplacedCount(flagged.length);
                }}
              >
                Replace with ASCII
              </Button>
            }
          >
            {flagged.length === 1
              ? 'One character is invisible or only looks like ASCII:'
              : `${flagged.length} characters are invisible or only look like ASCII:`}
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {flaggedRows(flagged).map(({ char, label, ascii, where }) => (
                <li key={char}>
                  {label}
                  {ascii === '' ? ', removed' : ascii === ' ' ? ', becomes a space' : (
                    <>
                      , becomes{' '}
                      <Box component="code" sx={{ fontFamily: editorFontFamily }}>{ascii}</Box>
                    </>
                  )}
                  : {where}
                </li>
              ))}
            </Box>
          </Alert>
        ) : replacedCount > 0 ? (
          <Alert severity="success" sx={{ mb: 1.5 }}>
            {replacedCount === 1 ? 'One character was' : `${replacedCount} characters were`} replaced
            with ASCII. Review the result before pasting it.
          </Alert>
        ) : null}
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
              confirm();
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
        <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 1 }}>
          Enter adds a new line while editing. Press Ctrl+Enter or ⌘Enter to paste.
        </Typography>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mt: 2 }}>
          <TextField
            size="small"
            label="Delay after each line"
            type="number"
            value={lineDelay}
            onChange={(event) => setLineDelay(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              confirm();
            }}
            slotProps={{
              input: { endAdornment: <InputAdornment position="end">ms</InputAdornment> },
              htmlInput: { min: 0, max: PASTE_DELAY_MAX.line, step: 50 },
            }}
            sx={{ width: 200, flexShrink: 0 }}
          />
          <Typography variant="caption" color="textSecondary">
            {pacingNote(text, { ...pacing, lineDelayMs }, mirrored)}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          ref={pasteButtonRef}
          variant="contained"
          color="warning"
          disabled={text.length === 0}
          onClick={confirm}
        >
          Paste
        </Button>
      </DialogActions>
    </Dialog>
  );
}
