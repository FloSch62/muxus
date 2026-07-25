import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useApplyFolderMoves } from '../../api/host-groups.js';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import {
  folderKey,
  folderLabel,
  folderParentPath,
  folderPath,
  folderSegments,
  isDescendantPath,
  isSamePath,
  knownFolderPaths,
  normalizeGroupPath,
  sanitizeFolderName,
} from '../../host-tree.js';
import { managedHostKey } from '../../managed-hosts.js';
import { showToast } from '../../state/toast.js';
import { usePrefsStore } from '../../state/prefs.js';
import { useUiStore } from '../../state/ui.js';
import { HostColorPicker } from '../HostColorPicker.js';
import { FolderPathField } from '../FolderPathField.js';
import { folderIcon, FOLDER_ICONS } from './folder-icons.js';
import {
  folderProblemMessage,
  folderRewritePlan,
  folderTargetProblem,
  moveHostPlan,
} from './folder-mutations.js';
import { useFolderPrefs } from './useFolderPrefs.js';
import { useAllManagedHosts } from './useAllManagedHosts.js';

/**
 * Create, rename, re-parent and style a sidebar folder, and pick the folder a
 * single host belongs to. All four are the same underlying edit — a rewrite of
 * one group path — so they share a dialog rather than being three near-copies.
 */
export function FolderDialog() {
  const state = useUiStore((s) => s.folderDialog);
  const setState = useUiStore((s) => s.setFolderDialog);
  const folders = useFolderPrefs();
  const applyMoves = useApplyFolderMoves();
  const allHosts = useAllManagedHosts();
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const emptyFolders = usePrefsStore((s) => s.sidebarEmptyFolders);

  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [color, setColor] = useState<string | undefined>();
  const [icon, setIcon] = useState<string | undefined>();

  // Load the folder's current shape once, when the dialog opens on it.
  useEffect(() => {
    if (state === false) return;
    if (state.mode === 'move-host') {
      setName('');
      setParent(state.currentPath);
      return;
    }
    if (state.mode === 'new') {
      setName('');
      setParent(state.parentPath ?? '');
      setColor(undefined);
      setIcon(undefined);
      return;
    }
    const style = usePrefsStore.getState().sidebarFolderStyles[folderKey(state.path)];
    setName(folderLabel(state.path));
    setParent(folderParentPath(state.path));
    setColor(style?.color);
    setIcon(style?.icon);
  }, [state]);

  const movingHost = state !== false && state.mode === 'move-host' ? state : undefined;
  const mode = state === false ? undefined : state.mode;
  const sourcePath = state !== false && state.mode === 'edit' ? state.path : '';

  const target = movingHost
    ? normalizeGroupPath(parent)
    : folderPath([...folderSegments(parent), sanitizeFolderName(name)]);
  const problem = movingHost ? undefined : folderTargetProblem(sourcePath, target);
  const renaming = mode === 'edit' && !!sourcePath && !isSamePath(sourcePath, target);
  const affected = useMemo(
    () => (renaming ? folderRewritePlan(allHosts, sourcePath, target) : []),
    [renaming, allHosts, sourcePath, target],
  );
  const merging = useMemo(
    () =>
      renaming &&
      knownFolderPaths(config?.hosts ?? [], savedData?.profiles ?? [], emptyFolders).some((path) =>
        isSamePath(path, target),
      ),
    [renaming, config?.hosts, savedData?.profiles, emptyFolders, target],
  );

  if (state === false) return null;

  const close = () => setState(false);

  const submit = () => {
    if (movingHost) {
      const host = allHosts.find((entry) => managedHostKey(entry) === movingHost.hostKey);
      if (host) {
        applyMoves.mutate({ moves: [moveHostPlan(host, target)], label: movingHost.hostName });
      }
      close();
      return;
    }
    if (problem) return;

    if (mode === 'new') {
      folders.addEmptyFolder(target);
      folders.setFolderStyle(folderKey(target), { color, icon });
      close();
      return;
    }

    // Style first: it is local and instant, so the folder keeps its look while
    // the hosts underneath it are still moving.
    folders.setFolderStyle(folderKey(renaming ? target : sourcePath), { color, icon });
    if (renaming) {
      folders.renameFolderPrefs(sourcePath, target);
      folders.removeEmptyFolder(sourcePath);
      if (affected.length > 0) applyMoves.mutate({ moves: affected, label: target });
      else folders.addEmptyFolder(target);
      showToast('success', `Folder renamed to “${target}”.`);
    }
    close();
  };

  const Preview = folderIcon(icon, true);
  const title = movingHost
    ? `Move “${movingHost.hostName}”`
    : mode === 'new'
      ? 'New folder'
      : `Edit “${folderLabel(sourcePath)}”`;
  const parentPreview = folderParentPath(target);

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogTitle sx={{ pb: 0.75 }}>{title}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Folders are local to Muxus. They never change your ssh config.
          </Typography>

          <Stack spacing={2.25}>
            {!movingHost && (
              <TextField
                label="Folder name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                helperText={
                  name.includes('/')
                    ? 'A name cannot contain “/” — use the field below to nest.'
                    : 'The name shown in the sidebar.'
                }
                fullWidth
              />
            )}
            <FolderPathField
              value={parent}
              onChange={setParent}
              label={movingHost ? 'Folder' : 'Inside folder'}
              error={!!problem && problem.kind !== 'empty'}
              helperText={
                problem && problem.kind !== 'empty'
                  ? folderProblemMessage(problem)
                  : movingHost
                    ? 'Leave empty to move this host out of every folder.'
                    : 'Leave empty for a top-level folder.'
              }
              exclude={
                sourcePath
                  ? (path) => isSamePath(path, sourcePath) || isDescendantPath(path, sourcePath)
                  : undefined
              }
            />

            {!movingHost && (
              <>
                <HostColorPicker value={color} onChange={setColor} />
                <Box>
                  <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
                    Icon
                  </Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    {FOLDER_ICONS.map((entry) => {
                      const selected = (icon ?? 'folder') === entry.id;
                      const Glyph = entry.Icon;
                      return (
                        <Tooltip key={entry.id} title={entry.label}>
                          <ButtonBase
                            aria-label={`${entry.label} folder icon`}
                            onClick={() => setIcon(entry.id === 'folder' ? undefined : entry.id)}
                            sx={{
                              width: 30,
                              height: 30,
                              borderRadius: 1,
                              border: 1,
                              borderColor: selected ? 'primary.main' : 'divider',
                              color: selected ? (color ?? 'primary.main') : 'text.secondary',
                            }}
                          >
                            <Glyph sx={{ fontSize: 17 }} />
                          </ButtonBase>
                        </Tooltip>
                      );
                    })}
                  </Stack>
                </Box>

                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    p: 1.25,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    bgcolor: 'sidebar',
                  }}
                >
                  <Preview sx={{ fontSize: 18, color: color ?? 'text.secondary' }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                      {sanitizeFolderName(name) || 'Folder'}
                    </Typography>
                    {parentPreview && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        sx={{ display: 'block' }}
                      >
                        in {parentPreview.split('/').join(' / ')}
                      </Typography>
                    )}
                  </Box>
                </Box>
              </>
            )}

            {renaming && affected.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                {merging
                  ? `Merges into the existing “${folderLabel(target)}” and moves ${affected.length} host${affected.length === 1 ? '' : 's'}.`
                  : `Moves ${affected.length} host${affected.length === 1 ? '' : 's'}.`}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={(!movingHost && !!problem) || applyMoves.isPending}
          >
            {movingHost ? 'Move' : mode === 'new' ? 'Create' : 'Save'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
