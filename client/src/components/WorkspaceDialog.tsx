import { useMemo, useState } from 'react';
import type { WorkspaceSummary } from '@muxus/shared';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ClearIcon from '@mui/icons-material/Clear';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import {
  deleteWorkspace,
  openWorkspace,
  renameWorkspace,
  saveWorkspaceAs,
  setStartupWorkspace,
} from '../workspace-persistence.js';
import {
  selectWorkspaces,
  type WorkspaceSort,
} from '../workspace-list.js';
import { confirmDiscardRemoteEditors } from '../editor/remote-editor-registry.js';
import { confirmAction } from '../state/dialogs.js';
import { useTabsStore } from '../state/tabs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspacesStore } from '../state/workspaces.js';

type NameAction =
  | { kind: 'save-as' }
  | { kind: 'rename'; id: string; previousName: string };

interface WorkspaceMenu {
  workspace: WorkspaceSummary;
  anchor?: HTMLElement;
  position?: { top: number; left: number };
}

function activityLabel(workspace: WorkspaceSummary): string {
  const opened = workspace.lastOpenedAt;
  const timestamp = opened ?? workspace.updatedAt;
  return `${opened ? 'Opened' : 'Updated'} ${new Date(timestamp).toLocaleString(
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  )}`;
}

export function WorkspaceDialog() {
  const open = useUiStore((state) => state.workspacesOpen);
  const setOpen = useUiStore((state) => state.setWorkspacesOpen);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeId = useWorkspacesStore((state) => state.activeId);
  const activeName = useWorkspacesStore((state) => state.activeName);
  const startupId = useWorkspacesStore((state) => state.startupId);
  const ready = useWorkspacesStore((state) => state.ready);
  const busy = useWorkspacesStore((state) => state.busy);
  const tabs = useTabsStore((state) => state.tabs);
  const reconnect = useTabsStore((state) => state.reconnect);
  const reconnectAll = useTabsStore((state) => state.reconnectAll);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<WorkspaceSort>('recent');
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [name, setName] = useState('');
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenu | null>(null);
  const [pendingOpenId, setPendingOpenId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const visibleWorkspaces = useMemo(
    () => selectWorkspaces(workspaces, query, sort, activeId),
    [activeId, query, sort, workspaces],
  );
  const reconnectable = useMemo(
    () => tabs.filter((tab) => tab.profile && tab.status === 'closed'),
    [tabs],
  );
  const liveCount = tabs.filter(
    (tab) => tab.profile && (tab.status === 'connected' || tab.status === 'connecting'),
  ).length;
  const selected = new Set(selectedIds);
  const pendingOpen = workspaces.find((workspace) => workspace.id === pendingOpenId);

  const beginSaveAs = () => {
    setNameAction({ kind: 'save-as' });
    setName(`${activeName} copy`);
  };

  const beginRename = (workspace: WorkspaceSummary) => {
    setWorkspaceMenu(null);
    setNameAction({
      kind: 'rename',
      id: workspace.id,
      previousName: workspace.name,
    });
    setName(workspace.name);
  };

  const commitNameAction = async () => {
    const trimmed = name.trim();
    if (!trimmed || !nameAction) return;
    try {
      if (nameAction.kind === 'save-as') {
        await saveWorkspaceAs(trimmed);
        showToast('success', `Saved workspace “${trimmed}”.`);
      } else {
        await renameWorkspace(nameAction.id, trimmed);
        showToast('success', `Renamed workspace to “${trimmed}”.`);
      }
      setNameAction(null);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const performOpen = async (id: string) => {
    if (!(await confirmDiscardRemoteEditors(tabs.map((tab) => tab.id)))) return;
    try {
      const workspace = await openWorkspace(id);
      setPendingOpenId(undefined);
      setSelectedIds([]);
      showToast('success', `Opened workspace “${workspace.name}”.`);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const requestOpen = (id: string) => {
    setWorkspaceMenu(null);
    if (id === activeId) return;
    if (liveCount > 0) setPendingOpenId(id);
    else void performOpen(id);
  };

  const performDelete = async (workspace: WorkspaceSummary) => {
    setWorkspaceMenu(null);
    setPendingOpenId(undefined);
    const confirmed = await confirmAction({
      title: `Delete workspace “${workspace.name}”?`,
      description:
        workspace.id === activeId
          ? 'The saved layout is removed and the current layout becomes unsaved. Open sessions keep running.'
          : 'The saved layout and its multi-execution groups are removed. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deleteWorkspace(workspace.id);
      if (nameAction?.kind === 'rename' && nameAction.id === workspace.id) {
        setNameAction(null);
      }
      showToast(
        'success',
        workspace.id === activeId
          ? `Deleted workspace “${workspace.name}”. The current layout is now unsaved.`
          : `Deleted workspace “${workspace.name}”.`,
      );
    } catch (error) {
      showErrorToast(error);
    }
  };

  const toggleStartup = async (id: string) => {
    setWorkspaceMenu(null);
    try {
      await setStartupWorkspace(startupId === id ? null : id);
      showToast(
        'success',
        startupId === id
          ? 'Muxus will reopen the most recently used workspace.'
          : 'Startup workspace updated.',
      );
    } catch (error) {
      showErrorToast(error);
    }
  };

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeId);
  const resultLabel = query.trim()
    ? `${visibleWorkspaces.length} of ${workspaces.length}`
    : `${workspaces.length}`;

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      maxWidth="md"
      fullWidth
      slotProps={{ paper: { sx: { maxHeight: 'min(820px, calc(100% - 48px))' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WorkspacesOutlinedIcon color="primary" />
        <Box component="span" sx={{ flex: 1 }}>
          Workspaces
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={`${workspaces.length} saved`}
          aria-label={`${workspaces.length} saved workspaces`}
        />
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{
            px: 2,
            py: 1.5,
            alignItems: { xs: 'stretch', sm: 'center' },
            bgcolor: 'action.hover',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">
              Current workspace
            </Typography>
            <Typography variant="subtitle1" noWrap>
              {activeName}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              startIcon={<SaveAsOutlinedIcon />}
              disabled={!ready || busy}
              onClick={beginSaveAs}
            >
              Save as
            </Button>
            <Button
              size="small"
              startIcon={<DriveFileRenameOutlineIcon />}
              disabled={!activeWorkspace || busy}
              onClick={() => {
                if (activeWorkspace) beginRename(activeWorkspace);
              }}
            >
              Rename
            </Button>
          </Stack>
        </Stack>

        {nameAction ? (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ px: 2, py: 1.5, alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <TextField
              fullWidth
              size="small"
              label={
                nameAction.kind === 'save-as'
                  ? 'New workspace name'
                  : `Rename “${nameAction.previousName}”`
              }
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitNameAction();
                if (event.key === 'Escape') setNameAction(null);
              }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                disabled={!name.trim() || busy}
                onClick={() => void commitNameAction()}
              >
                {nameAction.kind === 'save-as' ? 'Save' : 'Rename'}
              </Button>
              <Button onClick={() => setNameAction(null)}>Cancel</Button>
            </Stack>
          </Stack>
        ) : null}

        <Divider />
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ px: 2, pt: 1.5, pb: 1 }}
        >
          <TextField
            fullWidth
            size="small"
            placeholder="Search workspaces"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                visibleWorkspaces.length === 1 &&
                visibleWorkspaces[0]?.id !== activeId
              ) {
                event.preventDefault();
                requestOpen(visibleWorkspaces[0]!.id);
              }
              if (event.key === 'Escape' && query) setQuery('');
            }}
            slotProps={{
              htmlInput: { 'aria-label': 'Search saved workspaces' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <Tooltip title="Clear search">
                      <IconButton
                        edge="end"
                        size="small"
                        aria-label="Clear workspace search"
                        onClick={() => setQuery('')}
                      >
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          <TextField
            select
            size="small"
            label="Sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as WorkspaceSort)}
            sx={{ minWidth: { xs: '100%', sm: 170 } }}
          >
            <MenuItem value="recent">Recent activity</MenuItem>
            <MenuItem value="name">Name</MenuItem>
            <MenuItem value="created">Date created</MenuItem>
          </TextField>
        </Stack>

        <Stack
          direction="row"
          sx={{ px: 2, pb: 0.75, alignItems: 'baseline', justifyContent: 'space-between' }}
        >
          <Typography variant="overline" color="text.secondary">
            Saved workspaces
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {resultLabel}
          </Typography>
        </Stack>

        <List
          dense
          disablePadding
          aria-label="Saved workspaces"
          sx={{
            maxHeight: 'min(440px, 48vh)',
            overflowY: 'auto',
            borderTop: 1,
            borderColor: 'divider',
          }}
        >
          {visibleWorkspaces.map((workspace) => {
            const isActive = workspace.id === activeId;
            const isStartup = workspace.id === startupId;
            return (
              <ListItemButton
                key={workspace.id}
                selected={isActive}
                disabled={busy}
                onClick={() => requestOpen(workspace.id)}
                aria-label={
                  isActive
                    ? `${workspace.name}, currently open`
                    : `Open workspace ${workspace.name}`
                }
                sx={{
                  px: 2,
                  minHeight: 58,
                  borderBottom: 1,
                  borderColor: 'divider',
                  contentVisibility: 'auto',
                  containIntrinsicSize: '0 58px',
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (busy) return;
                  setWorkspaceMenu({
                    workspace,
                    position: {
                      top: event.clientY,
                      left: event.clientX,
                    },
                  });
                }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <WorkspacesOutlinedIcon
                    fontSize="small"
                    color={isActive ? 'primary' : 'inherit'}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{ fontWeight: isActive ? 600 : 400 }}
                      >
                        {workspace.name}
                      </Typography>
                      {isActive ? (
                        <Chip size="small" label="Open" color="primary" variant="outlined" />
                      ) : null}
                      {isStartup ? (
                        <Chip
                          size="small"
                          label="Startup"
                          icon={<StarIcon />}
                          color="warning"
                          variant="outlined"
                        />
                      ) : null}
                    </Stack>
                  }
                  secondary={activityLabel(workspace)}
                  slotProps={{ secondary: { noWrap: true } }}
                />
                <Tooltip title={`Actions for ${workspace.name}`}>
                  <IconButton
                    size="small"
                    aria-label={`Workspace actions for ${workspace.name}`}
                    aria-haspopup="menu"
                    onClick={(event) => {
                      event.stopPropagation();
                      setWorkspaceMenu({
                        workspace,
                        anchor: event.currentTarget,
                      });
                    }}
                  >
                    <MoreVertIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </ListItemButton>
            );
          })}
          {!ready ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 2, py: 3, textAlign: 'center' }}
            >
              Loading workspaces…
            </Typography>
          ) : null}
          {ready && workspaces.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 2, py: 3, textAlign: 'center' }}
            >
              Save the current layout to create your first named workspace.
            </Typography>
          ) : null}
          {ready && workspaces.length > 0 && visibleWorkspaces.length === 0 ? (
            <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                No workspaces match “{query.trim()}”.
              </Typography>
              <Button size="small" sx={{ mt: 0.5 }} onClick={() => setQuery('')}>
                Clear search
              </Button>
            </Box>
          ) : null}
        </List>

        {pendingOpen ? (
          <Alert
            severity="warning"
            sx={{ mx: 2, mt: 1.5 }}
            action={
              <Stack direction="row" spacing={0.5}>
                <Button color="inherit" size="small" onClick={() => setPendingOpenId(undefined)}>
                  Cancel
                </Button>
                <Button
                  color="warning"
                  variant="contained"
                  size="small"
                  disabled={busy}
                  onClick={() => void performOpen(pendingOpen.id)}
                >
                  Open
                </Button>
              </Stack>
            }
          >
            Open “{pendingOpen.name}”? This ends {liveCount} live or connecting session
            {liveCount === 1 ? '' : 's'}.
          </Alert>
        ) : null}

        {reconnectable.length > 0 ? (
          <>
            <Divider sx={{ mt: 1.5 }} />
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ px: 2, pt: 1.25, display: 'block' }}
            >
              Reconnect sessions
            </Typography>
            <List dense disablePadding sx={{ maxHeight: 150, overflowY: 'auto', pb: 1 }}>
              {reconnectable.map((tab) => (
                <ListItemButton
                  key={tab.id}
                  onClick={() =>
                    setSelectedIds((current) =>
                      current.includes(tab.id)
                        ? current.filter((id) => id !== tab.id)
                        : [...current, tab.id],
                    )
                  }
                  sx={{ px: 2 }}
                >
                  <Checkbox
                    checked={selected.has(tab.id)}
                    tabIndex={-1}
                    size="small"
                    sx={{ p: 0.5, mr: 1 }}
                  />
                  <ListItemText
                    primary={tab.title}
                    secondary={tab.profile?.kind === 'ssh' ? tab.profile.target : tab.profile?.kind}
                  />
                </ListItemButton>
              ))}
            </List>
          </>
        ) : null}
      </DialogContent>

      <Menu
        anchorEl={workspaceMenu?.anchor}
        anchorReference={workspaceMenu?.position ? 'anchorPosition' : 'anchorEl'}
        anchorPosition={workspaceMenu?.position}
        open={Boolean(workspaceMenu)}
        onClose={() => setWorkspaceMenu(null)}
      >
        {workspaceMenu?.workspace.id !== activeId ? (
          <MenuItem onClick={() => requestOpen(workspaceMenu!.workspace.id)}>
            <ListItemIcon>
              <PlayArrowOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Open</ListItemText>
          </MenuItem>
        ) : null}
        <MenuItem
          disabled={busy}
          onClick={() => {
            if (workspaceMenu) beginRename(workspaceMenu.workspace);
          }}
        >
          <ListItemIcon>
            <DriveFileRenameOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={busy}
          onClick={() => {
            if (workspaceMenu) void toggleStartup(workspaceMenu.workspace.id);
          }}
        >
          <ListItemIcon>
            {workspaceMenu?.workspace.id === startupId ? (
              <StarBorderIcon fontSize="small" />
            ) : (
              <StarIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>
            {workspaceMenu?.workspace.id === startupId
              ? 'Clear startup workspace'
              : 'Open at startup'}
          </ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={busy}
          onClick={() => {
            if (workspaceMenu) void performDelete(workspaceMenu.workspace);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>

      <DialogActions>
        {reconnectable.length > 0 ? (
          <Button
            startIcon={<PlayArrowOutlinedIcon />}
            onClick={() => {
              const count = selectedIds.length || reconnectable.length;
              if (selectedIds.length) reconnect(selectedIds);
              else reconnectAll();
              showToast(
                'info',
                `Reconnecting ${count} session${count === 1 ? '' : 's'}…`,
              );
              setSelectedIds([]);
            }}
          >
            {selectedIds.length ? 'Reconnect selected' : 'Reconnect all'}
          </Button>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => setOpen(false)}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
