import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useActiveCommandButtonGroup } from '../command-button-groups.js';
import {
  commandButtonInput,
  commandButtonLabel,
  commandButtonsInGroup,
  filterCommandButtons,
} from '../command-buttons.js';
import { usePrefsStore, type CommandButton } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle, type TerminalAnchorPosition } from '../terminal/terminal-registry.js';
import { CommandButtonColorDot } from './command-button-style.js';

const menuCenter = (): TerminalAnchorPosition => ({
  top: Math.round(window.innerHeight / 2),
  left: Math.round(window.innerWidth / 2),
});

/**
 * Compact, keyboard-first picker for the commands shown in the action bar.
 * The group the bar shows comes first; the others follow in their own
 * sections, so a search reaches every saved command.
 */
export function CommandButtonMenu() {
  const buttons = usePrefsStore((state) => state.commandButtons);
  const { groups, shownId } = useActiveCommandButtonGroup();
  const activeId = useTabsStore((state) => state.activeId);
  const connected = useTabsStore((state) =>
    state.tabs.some((tab) => tab.id === state.activeId && tab.status === 'connected'),
  );
  const setMenuOpen = useUiStore((state) => state.setCommandButtonMenuOpen);
  const setButtonsOpen = useUiStore((state) => state.setCommandButtonsOpen);
  const [query, setQuery] = useState('');
  const [anchorPosition] = useState(
    () => terminalHandle(activeId)?.cursorAnchorPosition() ?? menuCenter(),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const firstResultRef = useRef<HTMLLIElement>(null);
  const manageRef = useRef<HTMLLIElement>(null);
  const sections = useMemo(() => {
    const shown = groups.find((group) => group.id === shownId);
    const ordered = shown ? [shown, ...groups.filter((group) => group !== shown)] : groups;
    return ordered
      .map((group) => ({
        group,
        buttons: filterCommandButtons(commandButtonsInGroup(buttons, groups, group.id), query),
      }))
      .filter((section) => section.buttons.length > 0);
  }, [buttons, groups, shownId, query]);
  const filteredButtons = useMemo(
    () => sections.flatMap((section) => section.buttons),
    [sections],
  );
  const showSections = groups.length > 1;
  // Keep labels aligned: uncolored commands get an empty slot beside colored ones.
  const anyColor = filteredButtons.some((button) => button.color);
  const firstEnabledButton = connected
    ? filteredButtons.find((button) => button.command.trim())
    : undefined;

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const restoreTerminalFocus = () => {
    requestAnimationFrame(() => terminalHandle(activeId)?.focus());
  };
  const close = () => {
    setMenuOpen(false);
    restoreTerminalFocus();
  };
  const send = (button: CommandButton) => {
    setMenuOpen(false);
    const sent = terminalHandle(activeId)?.sendInput(commandButtonInput(button)) ?? false;
    if (!sent) showToast('warning', 'The active terminal is not connected.');
    restoreTerminalFocus();
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keep MenuList's built-in type-ahead from stealing printable keys from
    // the search box. Once a result has focus, its native arrow/Enter behavior
    // takes over.
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      (firstResultRef.current ?? manageRef.current)?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      manageRef.current?.focus();
    } else if (event.key === 'Enter') {
      if (!firstEnabledButton) return;
      event.preventDefault();
      send(firstEnabledButton);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <Menu
      open
      autoFocus={false}
      onClose={close}
      anchorReference="anchorPosition"
      anchorPosition={anchorPosition}
      slotProps={{
        list: { 'aria-label': 'Saved commands', dense: true },
        paper: { sx: { minWidth: 280, maxWidth: 420, maxHeight: 360 } },
      }}
    >
      <ListSubheader sx={{ py: 1, lineHeight: 1, bgcolor: 'background.paper' }}>
        <TextField
          inputRef={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search commands"
          fullWidth
          slotProps={{
            htmlInput: { 'aria-label': 'Search saved commands' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
      </ListSubheader>
      {buttons.length === 0 ? <MenuItem disabled>No saved commands yet</MenuItem> : null}
      {buttons.length > 0 && filteredButtons.length === 0 ? (
        <MenuItem disabled>No matching commands</MenuItem>
      ) : null}
      {sections.flatMap(({ group, buttons: sectionButtons }) => {
        const items: ReactNode[] = sectionButtons.map((button) => {
          const command = button.command.trim();
          return (
            <MenuItem
              key={button.id}
              ref={button.id === firstEnabledButton?.id ? firstResultRef : undefined}
              disabled={!connected || !command}
              title={command || undefined}
              onClick={() => send(button)}
              sx={{ gap: 1.25 }}
            >
              {anyColor ? (
                button.color ? (
                  <CommandButtonColorDot color={button.color} />
                ) : (
                  <Box component="span" sx={{ width: 8, flexShrink: 0 }} />
                )
              ) : null}
              <Typography variant="body2" noWrap sx={{ maxWidth: 370 }}>
                {commandButtonLabel(button)}
              </Typography>
            </MenuItem>
          );
        });
        // A plain subheader is skipped by arrow-key navigation, unlike a menu item.
        return showSections
          ? [
              <ListSubheader
                key={`group:${group.id}`}
                disableSticky
                sx={{
                  lineHeight: '28px',
                  bgcolor: 'transparent',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'text.secondary',
                }}
              >
                {group.name}
              </ListSubheader>,
              ...items,
            ]
          : items;
      })}
      <Divider />
      <MenuItem
        ref={manageRef}
        onClick={() => {
          setMenuOpen(false);
          setButtonsOpen(true);
        }}
      >
        <ListItemIcon>
          <SettingsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Manage command buttons…
      </MenuItem>
    </Menu>
  );
}
