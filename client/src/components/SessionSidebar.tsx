import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import TerminalIcon from '@mui/icons-material/Terminal';
import { useSshConfigHosts } from '../api/queries.js';
import { openConfigHost, openLocalTerminal, openSavedSession } from '../session-actions.js';
import { useSessionsStore, type SavedSession } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';
import { layout } from '../theme.js';

/**
 * The session manager: saved SSH sessions (grouped), the parsed ~/.ssh/config
 * aliases, and a local-terminal entry. Clicking anything opens a tab.
 */
export function SessionSidebar() {
  const sessions = useSessionsStore((s) => s.sessions);
  const removeSession = useSessionsStore((s) => s.remove);
  const setSessionDialog = useUiStore((s) => s.setSessionDialog);
  const { data: sshConfig } = useSshConfigHosts();
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ anchor: HTMLElement; session: SavedSession } | null>(null);

  const needle = filter.trim().toLowerCase();
  const match = (text: string) => !needle || text.toLowerCase().includes(needle);

  const grouped = useMemo(() => {
    const groups = new Map<string, SavedSession[]>();
    for (const s of sessions) {
      if (!match(`${s.name} ${s.host} ${s.user ?? ''}`)) continue;
      const key = s.group?.trim() || '';
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, needle]);

  const configHosts = (sshConfig?.hosts ?? []).filter((h) => match(`${h.alias} ${h.hostname ?? ''} ${h.user ?? ''}`));

  return (
    <Box
      sx={{
        width: layout.sidebarWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        borderRight: 1,
        borderColor: 'divider',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ p: 1.25, pb: 0.75, alignItems: 'center' }}>
        <TextField
          fullWidth
          placeholder="Filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <Tooltip title="New SSH session">
          <IconButton size="small" aria-label="New SSH session" onClick={() => setSessionDialog('new')}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
        <List dense disablePadding>
          <ListItemButton onClick={() => openLocalTerminal()}>
            <ListItemIcon sx={{ minWidth: 32 }}>
              <TerminalIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Local terminal" />
          </ListItemButton>
        </List>
        {grouped.map(([group, list]) => (
          <List
            key={group || '(ungrouped)'}
            dense
            disablePadding
            subheader={
              <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '28px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {group || 'Sessions'}
              </ListSubheader>
            }
          >
            {list.map((s) => (
              <ListItemButton key={s.id} onClick={() => openSavedSession(s)}>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <DnsOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={s.name}
                  secondary={`${s.user ? `${s.user}@` : ''}${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`}
                  slotProps={{ secondary: { sx: { fontSize: 11 } } }}
                />
                <IconButton
                  size="small"
                  edge="end"
                  aria-label={`Options for ${s.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu({ anchor: e.currentTarget, session: s });
                  }}
                >
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </ListItemButton>
            ))}
          </List>
        ))}
        {configHosts.length > 0 && (
          <List
            dense
            disablePadding
            subheader={
              <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '28px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                ~/.ssh/config
              </ListSubheader>
            }
          >
            {configHosts.map((h) => (
              <ListItemButton key={h.alias} onClick={() => openConfigHost(h.alias, h)}>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <DnsOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={h.alias}
                  secondary={h.hostname && h.hostname !== h.alias ? `${h.user ? `${h.user}@` : ''}${h.hostname}` : undefined}
                  slotProps={{ secondary: { sx: { fontSize: 11 } } }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
        {grouped.length === 0 && configHosts.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>
            {needle ? 'No sessions match.' : 'No saved sessions yet — create one with +.'}
          </Typography>
        )}
      </Box>
      <Menu open={!!menu} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            if (menu) setSessionDialog(menu.session);
            setMenu(null);
          }}
        >
          Edit
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) removeSession(menu.session.id);
            setMenu(null);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </Box>
  );
}
