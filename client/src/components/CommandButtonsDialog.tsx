import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import { newPreferenceId } from '../command-buttons.js';
import { confirmAction } from '../state/dialogs.js';
import {
  usePrefsStore,
  type CommandBarPosition,
  type CommandButton,
} from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';

export function CommandButtonsDialog() {
  const open = useUiStore((state) => state.commandButtonsOpen);
  const setOpen = useUiStore((state) => state.setCommandButtonsOpen);
  const buttons = usePrefsStore((state) => state.commandButtons);
  const showCommandBar = usePrefsStore((state) => state.showCommandBar);
  const commandBarPosition = usePrefsStore((state) => state.commandBarPosition);
  const setPrefs = usePrefsStore((state) => state.set);
  const setButtons = (commandButtons: CommandButton[]) => setPrefs({ commandButtons });

  const update = (id: string, patch: Partial<CommandButton>) => {
    setButtons(buttons.map((button) => (button.id === id ? { ...button, ...patch } : button)));
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= buttons.length) return;
    const next = [...buttons];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setButtons(next);
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
      <DialogTitle>Command buttons</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
          Save commands you use often. Open them with Ctrl+Space or keep the optional
          one-click bar above or below the terminals. Commands stay in the order shown here.
        </Typography>
        <Stack spacing={1.25}>
          <Paper
            variant="outlined"
            sx={{ p: 1.25, display: 'flex', alignItems: 'center', gap: 2 }}
          >
            <FormControlLabel
              sx={{ m: 0, flex: 1 }}
              control={
                <Switch
                  size="small"
                  checked={showCommandBar}
                  onChange={(event) => setPrefs({ showCommandBar: event.target.checked })}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">Show command bar</Typography>
                  <Typography variant="caption" color="textSecondary">
                    Display saved commands {commandBarPosition === 'bottom' ? 'below' : 'above'}{' '}
                    the terminals. The Ctrl+Space menu always remains available.
                  </Typography>
                </Box>
              }
            />
            <ToggleButtonGroup
              exclusive
              size="small"
              aria-label="Command bar position"
              disabled={!showCommandBar}
              value={commandBarPosition}
              onChange={(_event, value: CommandBarPosition | null) => {
                if (value) setPrefs({ commandBarPosition: value });
              }}
              sx={{ flexShrink: 0 }}
            >
              <ToggleButton value="top" sx={{ px: 1.25, gap: 0.5 }}>
                <VerticalAlignTopIcon fontSize="small" />
                Top
              </ToggleButton>
              <ToggleButton value="bottom" sx={{ px: 1.25, gap: 0.5 }}>
                <VerticalAlignBottomIcon fontSize="small" />
                Bottom
              </ToggleButton>
            </ToggleButtonGroup>
          </Paper>
          {buttons.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="textSecondary">
                No command buttons yet.
              </Typography>
            </Paper>
          ) : null}
          {buttons.map((button, index) => (
            <Paper key={button.id} variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <TextField
                    label="Button label"
                    value={button.label}
                    onChange={(event) => update(button.id, { label: event.target.value })}
                    slotProps={{ htmlInput: { maxLength: 80 } }}
                    sx={{ width: 210, flexShrink: 0 }}
                  />
                  <TextField
                    label="Command"
                    value={button.command}
                    onChange={(event) => update(button.id, { command: event.target.value })}
                    placeholder="systemctl status nginx"
                    fullWidth
                    multiline
                    maxRows={3}
                  />
                  <Stack direction="row" spacing={0}>
                    <Tooltip title="Move up">
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Move ${button.label || 'command'} up`}
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
                          size="small"
                          aria-label={`Move ${button.label || 'command'} down`}
                          disabled={index === buttons.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDownwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Delete button">
                      <IconButton
                        size="small"
                        color="error"
                        aria-label={`Delete ${button.label || 'command'} button`}
                        onClick={() => {
                          void confirmAction({
                            title: `Delete “${button.label.trim() || 'this command button'}”?`,
                            description: 'The saved command is removed from the action bar.',
                            confirmLabel: 'Delete',
                            destructive: true,
                          }).then((confirmed) => {
                            if (confirmed) {
                              setButtons(
                                buttons.filter((candidate) => candidate.id !== button.id),
                              );
                            }
                          });
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={button.sendEnter}
                      onChange={(event) => update(button.id, { sendEnter: event.target.checked })}
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body2">Run immediately</Typography>
                      <Typography variant="caption" color="textSecondary">
                        Send Enter after the command. Turn off to insert it for review first.
                      </Typography>
                    </Box>
                  }
                />
              </Stack>
            </Paper>
          ))}
          <Box>
            <Button
              startIcon={<AddIcon />}
              onClick={() =>
                setButtons([
                  ...buttons,
                  {
                    id: newPreferenceId('command'),
                    label: 'New command',
                    command: '',
                    sendEnter: true,
                  },
                ])
              }
            >
              Add button
            </Button>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => setOpen(false)}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
