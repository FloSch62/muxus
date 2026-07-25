import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import SearchIcon from '@mui/icons-material/Search';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import {
  chordsAreDefault,
  commandChords,
  conflictingCommandIds,
  isCommandCustomized,
} from '../keymap/bindings.js';
import {
  chordFromEvent,
  chordSignature,
  chordToString,
  formatChordString,
  isBindableChord,
  isModifierCode,
  parseChord,
} from '../keymap/chords.js';
import {
  COMMAND_CATEGORY_LABELS,
  KEY_COMMANDS,
  type CommandCategory,
  type KeyCommand,
} from '../keymap/commands.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { setChordCaptureActive } from '../shortcuts.js';
import { usePrefsStore } from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';

const CATEGORY_ORDER: CommandCategory[] = ['panes', 'tabs', 'terminal', 'app'];

/** Interactions worth documenting that no keymap entry can express. */
const EXTRAS: Array<[string, string]> = [
  ['Zoom the terminal with the mouse', 'Ctrl+Scroll wheel'],
  ['Resize a split / reset it to half', 'Drag the divider · double-click'],
  ['Pane actions (split, zoom, close)', 'Right-click the tab strip'],
  ['Rename a tab / close a tab', 'Double-click it · middle-click it'],
  ['Search next / previous match', 'Enter / Shift+Enter'],
];

const EDITOR_SHORTCUTS: Array<[string, string]> = [
  ['Save file / all files', `${HOTKEY_MOD_LABEL}S · ${HOTKEY_MOD_LABEL}K, S`],
  ['Find / replace', `${HOTKEY_MOD_LABEL}F · ${HOTKEY_MOD_LABEL}H`],
  ['Command palette', `F1 · ${HOTKEY_MOD_LABEL}Shift+P`],
  ['Go to line', `${HOTKEY_MOD_LABEL}G`],
  ['Format document', 'Shift+Alt+F'],
];

interface Recording {
  commandId: string;
  /** Replaces this chord when set, otherwise the chord is added. */
  index?: number;
}

export function ShortcutsDialog() {
  const open = useUiStore((state) => state.shortcutsOpen);
  const setOpen = useUiStore((state) => state.setShortcutsOpen);
  const keybindings = usePrefsStore((state) => state.keybindings);
  const setPrefs = usePrefsStore((state) => state.set);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [captureError, setCaptureError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const conflicts = useMemo(() => conflictingCommandIds(keybindings), [keybindings]);
  const customized = useMemo(
    () => KEY_COMMANDS.some((command) => isCommandCustomized(command, keybindings)),
    [keybindings],
  );

  // Filter and group in one pass: the sections below read their own bucket
  // instead of scanning the whole match list once per category.
  const { matchesByCategory, matchCount } = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byCategory = new Map<CommandCategory, KeyCommand[]>();
    let count = 0;
    for (const command of KEY_COMMANDS) {
      if (needle) {
        const haystack = [
          command.title,
          COMMAND_CATEGORY_LABELS[command.category],
          ...(command.keywords ?? []),
          ...commandChords(command, keybindings).map(formatChordString),
        ]
          .join(' ')
          .toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      const bucket = byCategory.get(command.category);
      if (bucket) bucket.push(command);
      else byCategory.set(command.category, [command]);
      count++;
    }
    return { matchesByCategory: byCategory, matchCount: count };
  }, [keybindings, query]);

  const applyChords = (command: KeyCommand, chords: string[]) => {
    const next = { ...keybindings };
    if (chordsAreDefault(command, chords)) delete next[command.id];
    else next[command.id] = chords;
    setPrefs({ keybindings: next });
  };

  // While recording, the dispatcher stands down so the chord being captured
  // cannot fire the command it is about to replace.
  useEffect(() => {
    if (!recording) return;
    setChordCaptureActive(true);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isModifierCode(event.code)) return;
      if (event.code === 'Escape') {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!isBindableChord(chord)) {
        setCaptureError('Add Ctrl, Alt, or Cmd — Shift alone would swallow ordinary typing.');
        return;
      }
      const command = KEY_COMMANDS.find((candidate) => candidate.id === recording.commandId);
      if (!command) {
        setRecording(null);
        return;
      }
      const text = chordToString(chord);
      const current = commandChords(command, keybindings);
      const signature = chordSignature(chord);
      const kept = current.filter((existing, index) => {
        if (recording.index === index) return false;
        const parsed = parseChord(existing);
        return !parsed || chordSignature(parsed) !== signature;
      });
      const chords =
        recording.index === undefined
          ? [...kept, text]
          : [...kept.slice(0, recording.index), text, ...kept.slice(recording.index)];
      applyChords(command, chords);
      setRecording(null);
      setCaptureError(undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      setChordCaptureActive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, keybindings]);

  const close = () => {
    setRecording(null);
    setCaptureError(undefined);
    setOpen(false);
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <KeyboardOutlinedIcon color="primary" />
        Keyboard
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          inputRef={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 17 }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: 260 }}
        />
      </DialogTitle>
      <DialogContent dividers sx={{ px: 3 }}>
        {recording ? (
          <Alert severity="info" icon={<KeyboardOutlinedIcon fontSize="small" />} sx={{ mb: 1.5 }}>
            {captureError ?? 'Press the key combination you want. Esc cancels.'}
          </Alert>
        ) : conflicts.size > 0 ? (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            Some commands share a chord. The first one that applies wins.
          </Alert>
        ) : null}

        {CATEGORY_ORDER.map((category) => {
          const commands = matchesByCategory.get(category);
          if (!commands || commands.length === 0) return null;
          return (
            <Box key={category} sx={{ mb: 2.5 }}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', letterSpacing: 0.8 }}
              >
                {COMMAND_CATEGORY_LABELS[category]}
              </Typography>
              {commands.map((command) => (
                <CommandRow
                  key={command.id}
                  command={command}
                  chords={commandChords(command, keybindings)}
                  conflicting={conflicts.has(command.id)}
                  customized={isCommandCustomized(command, keybindings)}
                  recording={recording?.commandId === command.id ? recording : undefined}
                  onRecord={(index) => {
                    setCaptureError(undefined);
                    setRecording({ commandId: command.id, index });
                  }}
                  onRemove={(index) =>
                    applyChords(
                      command,
                      commandChords(command, keybindings).filter((_, position) => position !== index),
                    )
                  }
                  onReset={() => {
                    const next = { ...keybindings };
                    delete next[command.id];
                    setPrefs({ keybindings: next });
                  }}
                />
              ))}
            </Box>
          );
        })}

        {matchCount === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
            No command matches “{query.trim()}”.
          </Typography>
        ) : null}

        <StaticSection title="Mouse and other gestures" rows={EXTRAS} />
        <StaticSection title="Remote editor" rows={EDITOR_SHORTCUTS} />
      </DialogContent>
      <DialogActions>
        <Button
          color="inherit"
          disabled={!customized}
          startIcon={<ReplayOutlinedIcon />}
          onClick={() => setPrefs({ keybindings: {} })}
        >
          Restore defaults
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={close}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CommandRow({
  command,
  chords,
  conflicting,
  customized,
  recording,
  onRecord,
  onRemove,
  onReset,
}: {
  command: KeyCommand;
  chords: string[];
  conflicting: boolean;
  customized: boolean;
  recording?: Recording;
  onRecord: (index?: number) => void;
  onRemove: (index: number) => void;
  onReset: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: 'center',
        py: 0.6,
        px: 1,
        mx: -1,
        borderRadius: 1,
        '&:hover': { bgcolor: (theme) => alpha(theme.palette.text.primary, 0.04) },
        '&:hover .muxus-chord-actions': { visibility: 'visible' },
        // Unbinding stays available but out of the way until the row is used.
        '& .MuiChip-deleteIcon': { opacity: 0, transition: 'opacity 120ms' },
        '&:hover .MuiChip-deleteIcon, & .MuiChip-root:focus-within .MuiChip-deleteIcon': {
          opacity: 1,
        },
      }}
    >
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
        {command.title}
      </Typography>
      {conflicting && (
        <Tooltip title="Another command uses this chord">
          <WarningAmberOutlinedIcon color="warning" sx={{ fontSize: 16 }} />
        </Tooltip>
      )}
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {chords.map((chord, index) => (
          <Chip
            key={`${chord}-${index}`}
            size="small"
            variant="outlined"
            label={
              recording && recording.index === index ? 'Press keys…' : formatChordString(chord)
            }
            onClick={() => onRecord(index)}
            onDelete={() => onRemove(index)}
            sx={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              ...(recording && recording.index === index
                ? { borderColor: 'primary.main', color: 'primary.main' }
                : {}),
            }}
          />
        ))}
        {chords.length === 0 && !recording && (
          <Typography variant="caption" color="text.disabled">
            Unbound
          </Typography>
        )}
        {recording && recording.index === undefined && (
          <Chip
            size="small"
            variant="outlined"
            label="Press keys…"
            sx={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              borderColor: 'primary.main',
              color: 'primary.main',
            }}
          />
        )}
      </Stack>
      <Stack
        direction="row"
        className="muxus-chord-actions"
        sx={{ visibility: recording ? 'visible' : 'hidden' }}
      >
        <Tooltip title="Add a chord">
          <IconButton size="small" aria-label={`Add a chord for ${command.title}`} onClick={() => onRecord()}>
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={customized ? 'Restore the default' : 'Default chord'}>
          <span>
            <IconButton
              size="small"
              disabled={!customized}
              aria-label={`Reset ${command.title} to its default chord`}
              onClick={onReset}
            >
              <ReplayOutlinedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

function StaticSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', letterSpacing: 0.8 }}>
        {title}
      </Typography>
      {rows.map(([label, keys]) => (
        <Stack key={label} direction="row" spacing={2} sx={{ alignItems: 'center', py: 0.55, px: 1, mx: -1 }}>
          <Typography variant="body2" sx={{ flex: 1 }}>
            {label}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: '"JetBrains Mono", monospace', whiteSpace: 'nowrap' }}
          >
            {keys}
          </Typography>
        </Stack>
      ))}
    </Box>
  );
}
