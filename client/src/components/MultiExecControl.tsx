import { useEffect, useMemo, useState } from 'react';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import PodcastsOutlinedIcon from '@mui/icons-material/PodcastsOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import { alpha } from '@mui/material/styles';
import { useChordLabel } from '../keymap/hints.js';
import { useMultiExecStore } from '../state/multi-exec.js';
import { useTabsStore } from '../state/tabs.js';
import { flattenPaneLayout } from '../state/workspace-layout.js';
import { withChord } from './ChordHint.js';

/** Target picker for automatic mirrored terminal input. */
export function MultiExecControl() {
  const tabs = useTabsStore((state) => state.tabs);
  const root = useTabsStore((state) => state.root);
  const activePaneId = useTabsStore((state) => state.activePaneId);
  const selectedIds = useMultiExecStore((state) => state.selectedIds);
  const groups = useMultiExecStore((state) => state.groups);
  const setSelection = useMultiExecStore((state) => state.setSelection);
  const toggleTarget = useMultiExecStore((state) => state.toggleTarget);
  const reconcile = useMultiExecStore((state) => state.reconcile);
  const saveGroup = useMultiExecStore((state) => state.saveGroup);
  const deleteGroup = useMultiExecStore((state) => state.deleteGroup);
  const activateGroup = useMultiExecStore((state) => state.activateGroup);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [groupName, setGroupName] = useState('');
  const toggleChord = useChordLabel('terminal.multi-exec');

  const connectedTabs = useMemo(
    () => tabs.filter((tab) => tab.profile && tab.status === 'connected'),
    [tabs],
  );
  // Any tab change (a title, a status) rebuilds the array, so key the id list
  // on its contents: reconciling then runs only when the ids really change.
  const connectedKey = connectedTabs.map((tab) => tab.id).join(',');
  const connectedIds = useMemo(
    () => (connectedKey ? connectedKey.split(',') : []),
    [connectedKey],
  );
  useEffect(() => {
    reconcile(connectedIds);
  }, [connectedIds, reconcile]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const connected = useMemo(() => new Set(connectedIds), [connectedIds]);
  const active = selectedIds.length >= 2;
  const visibleIds = new Set(
    flattenPaneLayout(root).panes
      .map(({ pane }) => pane.activeTabId)
      .filter((id): id is string => !!id && connected.has(id)),
  );
  const currentPaneIds = connectedTabs
    .filter((tab) => tab.paneId === activePaneId)
    .map((tab) => tab.id);

  return (
    <>
      <Tooltip
        title={withChord(
          active
            ? `Mirroring input across ${selectedIds.length} terminals`
            : 'Select terminals for multi-execution',
          // The chord toggles mirroring rather than opening this picker, so it
          // says so instead of standing alone as the button's own shortcut.
          toggleChord && `${toggleChord} toggles mirroring`,
        )}
      >
        <IconButton
          size="small"
          aria-label="Configure multi-execution"
          color={active ? 'warning' : 'default'}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={
            active
              ? (theme) => ({
                  bgcolor: alpha(theme.palette.warning.main, 0.12),
                  '&:hover': { bgcolor: alpha(theme.palette.warning.main, 0.2) },
                })
              : undefined
          }
        >
          <Badge
            badgeContent={selectedIds.length}
            color={active ? 'warning' : 'default'}
            max={99}
            invisible={selectedIds.length === 0}
          >
            <PodcastsOutlinedIcon fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 360, mt: 0.75, overflow: 'hidden' } } }}
      >
        <Stack direction="row" sx={{ px: 2, py: 1.5, alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">Multi-execution</Typography>
            <Typography variant="caption" color="text.secondary">
              Typing in any selected terminal mirrors to all selected terminals.
            </Typography>
          </Box>
          {active && <Chip label="Active" color="warning" variant="outlined" />}
        </Stack>
        <Divider />
        {groups.length > 0 ? (
          <>
            <Typography variant="overline" color="text.secondary" sx={{ px: 2, pt: 0.75 }}>
              Workspace groups
            </Typography>
            <List dense disablePadding sx={{ maxHeight: 140, overflowY: 'auto', pb: 0.5 }}>
              {groups.map((group) => {
                const connectedCount = group.tabIds.filter((id) => connected.has(id)).length;
                return (
                  <ListItemButton
                    key={group.id}
                    disabled={connectedCount === 0}
                    onClick={() => activateGroup(group.id, connectedIds)}
                    sx={{ mx: 0.75, pr: 0.5 }}
                  >
                    <PodcastsOutlinedIcon
                      fontSize="small"
                      color={connectedCount >= 2 ? 'warning' : 'disabled'}
                      sx={{ mr: 1.25 }}
                    />
                    <ListItemText
                      primary={group.name}
                      secondary={`${connectedCount} of ${group.tabIds.length} connected`}
                      slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                    />
                    <Tooltip title={`Delete ${group.name}`}>
                      <IconButton
                        size="small"
                        aria-label={`Delete multi-exec group ${group.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteGroup(group.id);
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </ListItemButton>
                );
              })}
            </List>
            <Divider />
          </>
        ) : null}
        <Stack direction="row" spacing={0.75} sx={{ px: 1.5, py: 1 }}>
          <Button
            variant="outlined"
            disabled={currentPaneIds.length === 0}
            onClick={() => setSelection(currentPaneIds)}
          >
            This split
          </Button>
          <Button
            variant="outlined"
            disabled={visibleIds.size === 0}
            onClick={() => setSelection([...visibleIds])}
          >
            Visible splits
          </Button>
          <Button
            variant="outlined"
            disabled={connectedIds.length === 0}
            onClick={() => setSelection(connectedIds)}
          >
            All live
          </Button>
        </Stack>
        <Divider />
        <List dense disablePadding sx={{ maxHeight: 300, overflow: 'auto', py: 0.5 }}>
          {connectedTabs.map((tab) => (
            <ListItemButton key={tab.id} onClick={() => toggleTarget(tab.id)} sx={{ mx: 0.75 }}>
              <Checkbox
                checked={selected.has(tab.id)}
                tabIndex={-1}
                disableRipple
                size="small"
                color="warning"
                sx={{ p: 0.5, mr: 0.75 }}
              />
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  mr: 1.25,
                  flexShrink: 0,
                  bgcolor: tab.color ?? 'success.main',
                }}
              />
              <ListItemText
                primary={tab.title}
                secondary={tab.paneId === activePaneId ? 'Current split' : 'Live session'}
                slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
              />
            </ListItemButton>
          ))}
          {connectedTabs.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3, textAlign: 'center' }}>
              Connect at least two sessions to start mirroring input.
            </Typography>
          )}
        </List>
        {selectedIds.length >= 2 ? (
          <Stack direction="row" spacing={0.75} sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider' }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Save selection as a group"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !groupName.trim()) return;
                saveGroup(groupName);
                setGroupName('');
              }}
            />
            <Button
              variant="outlined"
              startIcon={<SaveOutlinedIcon />}
              disabled={!groupName.trim()}
              onClick={() => {
                saveGroup(groupName);
                setGroupName('');
              }}
            >
              Save
            </Button>
          </Stack>
        ) : null}
        {selectedIds.length === 1 && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', px: 2, py: 1 }}>
            Select one more terminal to enable multi-execution.
          </Typography>
        )}
        {active && (
          <Stack
            direction="row"
            sx={{ px: 2, py: 1, alignItems: 'center', borderTop: 1, borderColor: 'divider' }}
          >
            <Typography variant="caption" color="warning.main" sx={{ flex: 1 }}>
              Input is mirrored automatically.
            </Typography>
            <Button color="inherit" onClick={() => setSelection([])}>
              Clear selection
            </Button>
          </Stack>
        )}
      </Popover>
    </>
  );
}
