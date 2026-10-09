import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import type { PasswordVaultSecret } from '@muxus/shared';
import { useQueryClient } from '@tanstack/react-query';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { terminalHandle, type TerminalAnchorPosition } from '../terminal/terminal-registry.js';
import { filterVaultSecrets, typeSecretIntoTab } from '../vault-secrets.js';

const menuCenter = (): TerminalAnchorPosition => ({
  top: Math.round(window.innerHeight / 2),
  left: Math.round(window.innerWidth / 2),
});

/**
 * Keyboard-first picker that types a named secret into the focused session,
 * and into the panes multi-execution mirrors it to. Only names are listed;
 * the backend types the value.
 */
export function SendSecretMenu() {
  const queryClient = useQueryClient();
  const { data: vault, isLoading } = usePasswordVaultStatus();
  const activeId = useTabsStore((state) => state.activeId);
  const connected = useTabsStore((state) =>
    state.tabs.some((tab) => tab.id === state.activeId && tab.status === 'connected'),
  );
  const setMenuOpen = useUiStore((state) => state.setSendSecretMenuOpen);
  const openSettings = useUiStore((state) => state.openSettings);
  const [query, setQuery] = useState('');
  const [anchorPosition] = useState(
    () => terminalHandle(activeId)?.cursorAnchorPosition() ?? menuCenter(),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const firstResultRef = useRef<HTMLLIElement>(null);
  const manageRef = useRef<HTMLLIElement>(null);
  const secrets = vault?.secrets;
  const filtered = useMemo(() => filterVaultSecrets(secrets ?? [], query), [secrets, query]);
  const first = connected ? filtered[0] : undefined;

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
  const send = (secret: PasswordVaultSecret, enter: boolean) => {
    setMenuOpen(false);
    if (!typeSecretIntoTab(activeId, secret, enter, queryClient)) {
      showToast('warning', 'The active terminal is not connected.');
    }
    restoreTerminalFocus();
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keep MenuList's type-ahead from taking printable keys from the search box.
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      (firstResultRef.current ?? manageRef.current)?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      manageRef.current?.focus();
    } else if (event.key === 'Enter') {
      if (!first) return;
      event.preventDefault();
      send(first, !event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const empty = !isLoading && (secrets?.length ?? 0) === 0;
  return (
    <Menu
      open
      autoFocus={false}
      onClose={close}
      anchorReference="anchorPosition"
      anchorPosition={anchorPosition}
      slotProps={{
        list: { 'aria-label': 'Send secret', dense: true },
        paper: { sx: { minWidth: 300, maxWidth: 420, maxHeight: 380 } },
      }}
    >
      <ListSubheader sx={{ py: 1, lineHeight: 1, bgcolor: 'background.paper' }}>
        <TextField
          inputRef={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search secrets"
          fullWidth
          slotProps={{
            htmlInput: { 'aria-label': 'Search secrets' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
        <Typography
          variant="caption"
          color="textSecondary"
          component="div"
          sx={{ mt: 0.75, lineHeight: 1.4 }}
        >
          Enter types it and presses Enter · Shift+Enter types it only
        </Typography>
      </ListSubheader>
      {empty ? (
        <MenuItem disabled>
          {vault?.configured === false ? 'No password vault yet' : 'No secrets saved yet'}
        </MenuItem>
      ) : null}
      {!empty && filtered.length === 0 && !isLoading ? (
        <MenuItem disabled>No matching secrets</MenuItem>
      ) : null}
      {filtered.map((secret) => (
        <MenuItem
          key={secret.id}
          ref={secret.id === first?.id ? firstResultRef : undefined}
          disabled={!connected}
          onClick={(event) => send(secret, !event.shiftKey)}
        >
          <ListItemIcon>
            <KeyOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <Typography variant="body2" noWrap sx={{ maxWidth: 260 }}>
            {secret.name}
          </Typography>
          {secret.username ? (
            <Box component="span" sx={{ ml: 'auto', pl: 1.5, color: 'text.secondary', fontSize: 12 }}>
              {secret.username}
            </Box>
          ) : null}
        </MenuItem>
      ))}
      <Divider />
      <MenuItem
        ref={manageRef}
        onClick={() => {
          setMenuOpen(false);
          openSettings({ section: 'passwords' });
        }}
      >
        <ListItemIcon>
          <SettingsOutlinedIcon fontSize="small" />
        </ListItemIcon>
        Manage secrets…
      </MenuItem>
    </Menu>
  );
}
