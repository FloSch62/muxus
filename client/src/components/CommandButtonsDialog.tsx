import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import { useActiveCommandButtonGroup } from '../command-button-groups.js';
import {
  COMMAND_BUTTON_COLORS,
  DEFAULT_COMMAND_GROUP_ID,
  MAX_COMMAND_BUTTON_GROUP_NAME,
  MAX_COMMAND_BUTTON_GROUPS,
  MAX_COMMAND_BUTTONS,
  commandButtonGroupOf,
  commandButtonInk,
  commandButtonsInGroup,
  duplicateCommandButton,
  moveCommandButton,
  moveCommandButtonGroup,
  moveCommandButtonToGroup,
  newPreferenceId,
  unusedCommandButtonGroupName,
  withoutCommandButtonGroup,
  type CommandButtonColor,
} from '../command-buttons.js';
import { confirmAction } from '../state/dialogs.js';
import {
  usePrefsStore,
  type CommandBarPosition,
  type CommandButton,
  type CommandButtonGroup,
} from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';
import { CommandButtonColorDot } from './command-button-style.js';
import { useAllManagedHosts } from './sidebar/useAllManagedHosts.js';
import { VaultSecretField } from './VaultSecretField.js';

export function CommandButtonsDialog() {
  const open = useUiStore((state) => state.commandButtonsOpen);
  const setOpen = useUiStore((state) => state.setCommandButtonsOpen);
  const buttons = usePrefsStore((state) => state.commandButtons);
  const groups = usePrefsStore((state) => state.commandButtonGroups);
  const showCommandBar = usePrefsStore((state) => state.showCommandBar);
  const commandBarPosition = usePrefsStore((state) => state.commandBarPosition);
  const setPrefs = usePrefsStore((state) => state.set);
  const hosts = useAllManagedHosts();
  // Opens on the group the bar shows, so "Manage" edits what you were looking at.
  const { shownId } = useActiveCommandButtonGroup();
  const [selectedId, setSelectedId] = useState(shownId);
  // A button or group just created, whose name field should take focus.
  const [focusId, setFocusId] = useState<string | null>(null);
  const group = groups.find((candidate) => candidate.id === selectedId) ?? groups[0]!;
  const groupButtons = commandButtonsInGroup(buttons, groups, group.id);
  const grouped = groups.length > 1;
  const isDefault = group.id === DEFAULT_COMMAND_GROUP_ID;
  const groupIndex = groups.indexOf(group);
  const groupNameRef = useSelectWhen(focusId === group.id, () => setFocusId(null));

  const setButtons = (commandButtons: CommandButton[]) => setPrefs({ commandButtons });
  const update = (id: string, patch: Partial<CommandButton>) => {
    setButtons(buttons.map((button) => (button.id === id ? { ...button, ...patch } : button)));
  };
  const renameGroup = (name: string) => {
    setPrefs({
      commandButtonGroups: groups.map((candidate) =>
        candidate.id === group.id ? { ...candidate, name } : candidate,
      ),
    });
  };
  const countIn = (groupId: string) =>
    buttons.filter((button) => commandButtonGroupOf(button, groups) === groupId).length;
  const hostsOpening = (groupId: string) =>
    hosts.filter((host) => host.entry.metadata?.commandButtonGroup === groupId).length;

  const addGroup = () => {
    const created: CommandButtonGroup = {
      id: newPreferenceId('command-group'),
      name: unusedCommandButtonGroupName(groups),
    };
    setPrefs({ commandButtonGroups: [...groups, created] });
    setSelectedId(created.id);
    setFocusId(created.id);
  };
  const addButton = () => {
    const created: CommandButton = {
      id: newPreferenceId('command'),
      label: 'New command',
      command: '',
      sendEnter: true,
      ...(isDefault ? {} : { groupId: group.id }),
    };
    setButtons([...buttons, created]);
    setFocusId(created.id);
  };
  const deleteGroup = () => {
    const count = groupButtons.length;
    const hostCount = hostsOpening(group.id);
    void confirmAction({
      title: `Delete “${group.name.trim() || 'this group'}”?`,
      description: [
        count === 0
          ? 'The group holds no command buttons.'
          : `Its ${count} command button${count === 1 ? ' is' : 's are'} deleted with it.`,
        hostCount > 0
          ? `${hostCount} host${hostCount === 1 ? '' : 's'} that open${hostCount === 1 ? 's' : ''} it will show the group chosen in the bar instead.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete group',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      const state = usePrefsStore.getState();
      setPrefs(
        withoutCommandButtonGroup(state.commandButtons, state.commandButtonGroups, group.id),
      );
      setSelectedId(groups[groupIndex - 1]?.id ?? DEFAULT_COMMAND_GROUP_ID);
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      maxWidth="md"
      fullWidth
      slotProps={{ paper: { sx: { height: 'min(720px, calc(100% - 64px))' } } }}
    >
      <DialogTitle>Command buttons</DialogTitle>
      <DialogContent
        sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', pb: 0.5 }}
      >
        <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
          Save commands you use often and sort them into groups, such as one per vendor or task;
          the bar shows one group at a time. Open them with Ctrl+Space or keep the optional
          one-click bar above or below the terminals.
        </Typography>
        <Paper
          variant="outlined"
          sx={{ p: 1.25, display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
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
        <Stack direction="row" spacing={2.5} sx={{ flex: 1, minHeight: 0, mt: 2 }}>
          <Stack
            sx={{ width: 190, flexShrink: 0, borderRight: 1, borderColor: 'divider', minHeight: 0 }}
          >
            <Tabs
              orientation="vertical"
              variant="scrollable"
              aria-label="Command groups"
              value={group.id}
              onChange={(_event, value: string) => setSelectedId(value)}
              sx={{
                minHeight: 0,
                '& .MuiTab-root': {
                  minHeight: 38,
                  alignItems: 'stretch',
                  textAlign: 'left',
                  textTransform: 'none',
                  fontSize: 13,
                  pl: 0.5,
                  pr: 1.5,
                },
              }}
            >
              {groups.map((candidate) => (
                <Tab
                  key={candidate.id}
                  value={candidate.id}
                  label={
                    <Box component="span" sx={{ display: 'flex', gap: 1, width: '100%' }}>
                      <Box
                        component="span"
                        sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {candidate.name.trim() || 'Untitled group'}
                      </Box>
                      <Box component="span" sx={{ color: 'text.secondary' }}>
                        {countIn(candidate.id)}
                      </Box>
                    </Box>
                  }
                />
              ))}
            </Tabs>
            <Box sx={{ pt: 0.5, pr: 1.5 }}>
              <Button
                startIcon={<AddIcon />}
                disabled={groups.length >= MAX_COMMAND_BUTTON_GROUPS}
                onClick={addGroup}
              >
                New group
              </Button>
            </Box>
          </Stack>
          <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', pt: 1, pr: 0.5, pb: 1 }}>
            {grouped ? (
              <Box sx={{ mb: 2 }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center' }}>
                  <TextField
                    key={group.id}
                    inputRef={groupNameRef}
                    label="Group name"
                    value={group.name}
                    onChange={(event) => renameGroup(event.target.value)}
                    onBlur={() => {
                      if (!group.name.trim()) {
                        renameGroup(isDefault ? 'Default' : 'Untitled group');
                      }
                    }}
                    slotProps={{ htmlInput: { maxLength: MAX_COMMAND_BUTTON_GROUP_NAME } }}
                    sx={{ width: 260 }}
                  />
                  {isDefault ? null : (
                    <>
                      <Tooltip title="Move group up">
                        <span>
                          <IconButton
                            size="small"
                            aria-label={`Move ${group.name} up`}
                            disabled={groupIndex <= 1}
                            onClick={() =>
                              setPrefs({
                                commandButtonGroups: moveCommandButtonGroup(groups, group.id, -1),
                              })
                            }
                          >
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move group down">
                        <span>
                          <IconButton
                            size="small"
                            aria-label={`Move ${group.name} down`}
                            disabled={groupIndex === groups.length - 1}
                            onClick={() =>
                              setPrefs({
                                commandButtonGroups: moveCommandButtonGroup(groups, group.id, 1),
                              })
                            }
                          >
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Button
                        color="error"
                        startIcon={<DeleteOutlineIcon />}
                        onClick={deleteGroup}
                        sx={{ ml: 'auto' }}
                      >
                        Delete group
                      </Button>
                    </>
                  )}
                </Stack>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  sx={{ display: 'block', mt: 0.75, ml: 1.75 }}
                >
                  {groupCaption(isDefault, hostsOpening(group.id))}
                </Typography>
              </Box>
            ) : null}
            <Stack spacing={1.25}>
              {groupButtons.length === 0 ? (
                <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
                  <Typography variant="body2" color="textSecondary">
                    {grouped ? 'No command buttons in this group yet.' : 'No command buttons yet.'}
                  </Typography>
                </Paper>
              ) : null}
              {groupButtons.map((button, index) => (
                <CommandButtonCard
                  key={button.id}
                  button={button}
                  groups={groups}
                  first={index === 0}
                  last={index === groupButtons.length - 1}
                  focusRequested={focusId === button.id}
                  onFocused={() => setFocusId(null)}
                  onChange={(patch) => update(button.id, patch)}
                  onMove={(offset) => setButtons(moveCommandButton(buttons, groups, button.id, offset))}
                  onMoveToGroup={(groupId) =>
                    setButtons(moveCommandButtonToGroup(buttons, groups, button.id, groupId))
                  }
                  duplicateDisabled={buttons.length >= MAX_COMMAND_BUTTONS}
                  onDuplicate={() => {
                    const id = newPreferenceId('command');
                    setButtons(duplicateCommandButton(buttons, button.id, id));
                    setFocusId(id);
                  }}
                  onDelete={() => {
                    void confirmAction({
                      title: `Delete “${button.label.trim() || 'this command button'}”?`,
                      description: 'The saved command is removed from the action bar.',
                      confirmLabel: 'Delete',
                      destructive: true,
                    }).then((confirmed) => {
                      if (!confirmed) return;
                      setButtons(
                        usePrefsStore
                          .getState()
                          .commandButtons.filter((candidate) => candidate.id !== button.id),
                      );
                    });
                  }}
                />
              ))}
              <Box>
                <Button
                  startIcon={<AddIcon />}
                  disabled={buttons.length >= MAX_COMMAND_BUTTONS}
                  onClick={addButton}
                >
                  Add button
                </Button>
              </Box>
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={() => setOpen(false)}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function groupCaption(isDefault: boolean, hostCount: number): string {
  if (hostCount > 0) {
    return `The bar switches to this group in sessions to ${hostCount} host${hostCount === 1 ? '' : 's'}.`;
  }
  return isDefault
    ? 'Holds every command not filed under another group.'
    : 'To switch to it for a host, choose it under Terminal appearance in the host editor.';
}

function CommandButtonCard({
  button,
  groups,
  first,
  last,
  focusRequested,
  onFocused,
  onChange,
  onMove,
  onMoveToGroup,
  duplicateDisabled,
  onDuplicate,
  onDelete,
}: {
  button: CommandButton;
  groups: readonly CommandButtonGroup[];
  first: boolean;
  last: boolean;
  /** Just created: select the label so typing replaces it. */
  focusRequested: boolean;
  onFocused: () => void;
  onChange: (patch: Partial<CommandButton>) => void;
  onMove: (offset: -1 | 1) => void;
  onMoveToGroup: (groupId: string) => void;
  duplicateDisabled: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const name = button.label || 'command';
  const labelRef = useSelectWhen(focusRequested, onFocused);
  // An empty id is a secret button whose secret is not picked yet.
  const sendsSecret = button.secretId !== undefined;
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField
            inputRef={labelRef}
            label="Button label"
            value={button.label}
            onChange={(event) => onChange({ label: event.target.value })}
            slotProps={{
              htmlInput: { maxLength: 80 },
              input: {
                startAdornment: (
                  <InputAdornment position="start" sx={{ mr: 0.5 }}>
                    <ColorPicker
                      value={button.color}
                      onChange={(color) => onChange({ color })}
                    />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ width: 220, flexShrink: 0 }}
          />
          {sendsSecret ? (
            <VaultSecretField
              value={button.secretId || undefined}
              onChange={(secretId) => onChange({ secretId })}
            />
          ) : (
            <TextField
              label="Command"
              value={button.command}
              onChange={(event) => onChange({ command: event.target.value })}
              placeholder="systemctl status nginx"
              fullWidth
              multiline
              maxRows={3}
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
          )}
          <Stack direction="row" spacing={0} sx={{ pt: 0.25 }}>
            <Tooltip title="Move up">
              <span>
                <IconButton
                  size="small"
                  aria-label={`Move ${name} up`}
                  disabled={first}
                  onClick={() => onMove(-1)}
                >
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton
                  size="small"
                  aria-label={`Move ${name} down`}
                  disabled={last}
                  onClick={() => onMove(1)}
                >
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Duplicate button">
              <span>
                <IconButton
                  size="small"
                  aria-label={`Duplicate ${name} button`}
                  disabled={duplicateDisabled}
                  onClick={onDuplicate}
                >
                  <ContentCopyOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Delete button">
              <IconButton
                size="small"
                color="error"
                aria-label={`Delete ${name} button`}
                onClick={onDelete}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label={`What ${name} sends`}
            value={sendsSecret ? 'secret' : 'command'}
            onChange={(_event, value: 'command' | 'secret' | null) => {
              if (value === 'secret' && !sendsSecret) {
                // Clear the text, so a password typed there before is not kept.
                onChange({ secretId: '', command: '' });
              } else if (value === 'command' && sendsSecret) {
                onChange({ secretId: undefined });
              }
            }}
            sx={{ flexShrink: 0 }}
          >
            <ToggleButton value="command" sx={{ px: 1.25, gap: 0.5 }}>
              <TerminalOutlinedIcon fontSize="small" />
              Command
            </ToggleButton>
            <ToggleButton value="secret" sx={{ px: 1.25, gap: 0.5 }}>
              <KeyOutlinedIcon fontSize="small" />
              Secret
            </ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            sx={{ m: 0, flex: 1 }}
            control={
              <Switch
                size="small"
                checked={button.sendEnter}
                onChange={(event) => onChange({ sendEnter: event.target.checked })}
              />
            }
            label={
              sendsSecret ? (
                <Box>
                  <Typography variant="body2">Press Enter after it</Typography>
                  <Typography variant="caption" color="textSecondary">
                    Answers a password prompt. Turn off to type the secret without Enter.
                  </Typography>
                </Box>
              ) : (
                <Box>
                  <Typography variant="body2">Run immediately</Typography>
                  <Typography variant="caption" color="textSecondary">
                    Send Enter after the command. Turn off to insert it for review first.
                  </Typography>
                </Box>
              )
            }
          />
          {groups.length > 1 ? (
            <TextField
              select
              label="Group"
              value={commandButtonGroupOf(button, groups)}
              onChange={(event) => onMoveToGroup(event.target.value)}
              sx={{ width: 180, flexShrink: 0 }}
            >
              {groups.map((candidate) => (
                <MenuItem key={candidate.id} value={candidate.id}>
                  {candidate.name.trim() || 'Untitled group'}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
}

/** The dot inside the label field; opens the palette. */
function ColorPicker({
  value,
  onChange,
}: {
  value: CommandButtonColor | undefined;
  onChange: (color: CommandButtonColor | undefined) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = COMMAND_BUTTON_COLORS.find((color) => color.id === value);
  const choose = (color: CommandButtonColor | undefined) => {
    setAnchor(null);
    onChange(color);
  };
  return (
    <>
      <Tooltip title={current ? `Color: ${current.name}` : 'Button color'}>
        <IconButton
          size="small"
          edge="start"
          aria-label={current ? `Button color: ${current.name}` : 'Button color: none'}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ p: 0.75 }}
        >
          <CommandButtonColorDot color={value} size={12} />
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1.25 } } }}
      >
        <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 1 }}>
          Button color
        </Typography>
        <Stack direction="row" spacing={0.75} useFlexGap>
          <Tooltip title="No color">
            <ButtonBase
              aria-pressed={!value}
              aria-label="No color"
              onClick={() => choose(undefined)}
              sx={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                border: 1,
                borderColor: value ? 'divider' : 'text.secondary',
              }}
            >
              {!value ? <CheckIcon sx={{ fontSize: 14, color: 'text.secondary' }} /> : null}
            </ButtonBase>
          </Tooltip>
          {COMMAND_BUTTON_COLORS.map((color) => (
            <Tooltip key={color.id} title={color.name}>
              <ButtonBase
                aria-pressed={value === color.id}
                aria-label={color.name}
                onClick={() => choose(color.id)}
                sx={(theme) => ({
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  bgcolor: commandButtonInk(color.id, theme.palette.mode),
                  '&:hover': { transform: 'scale(1.12)' },
                  transition: 'transform 120ms ease',
                })}
              >
                {value === color.id ? (
                  <CheckIcon
                    sx={(theme) => ({
                      fontSize: 14,
                      color: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.7)' : '#fff',
                    })}
                  />
                ) : null}
              </ButtonBase>
            </Tooltip>
          ))}
        </Stack>
      </Popover>
    </>
  );
}

/**
 * A ref for a field to focus with its text selected once `requested` turns
 * true, for names the user is expected to overwrite right away.
 */
function useSelectWhen(requested: boolean, onDone: () => void) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!requested) return;
    const frame = requestAnimationFrame(() => {
      ref.current?.select();
      done.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [requested]);
  return ref;
}
