import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import type { FolderAuthSettings } from '@muxus/shared';
import {
  folderSettingsForPath,
  hasFolderSettingsUnder,
  useFolderSettings,
  useMoveFolderSettings,
  useSaveFolderSettings,
} from '../../api/folder-settings.js';
import { useApplyFolderMoves } from '../../api/host-groups.js';
import { usePasswordVaultStatus } from '../../api/password-vault-queries.js';
import { useSavedHostProfiles, useSshConfig, useSshKeys } from '../../api/queries.js';
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
  const [authUser, setAuthUser] = useState('');
  const [authPort, setAuthPort] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [masterPassword, setMasterPassword] = useState('');

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

  const saveSettings = useSaveFolderSettings();
  const moveSettings = useMoveFolderSettings();
  const { data: settingsData } = useFolderSettings(state !== false && !movingHost);
  const { data: vaultStatus } = usePasswordVaultStatus();
  const { data: sshKeys } = useSshKeys(state !== false && !movingHost);
  const settingsRecord = sourcePath
    ? folderSettingsForPath(settingsData?.folders, sourcePath)
    : undefined;

  // Seed the credential fields separately: the settings arrive from their own
  // query and may land a beat after the dialog opens.
  const seedUser = settingsRecord?.auth.user ?? '';
  const seedPort = settingsRecord?.auth.port !== undefined ? String(settingsRecord.auth.port) : '';
  const seedKey = settingsRecord?.auth.identityFiles?.[0] ?? '';
  useEffect(() => {
    if (state === false || state.mode === 'move-host') return;
    const editing = state.mode === 'edit';
    setAuthUser(editing ? seedUser : '');
    setAuthPort(editing ? seedPort : '');
    setAuthKey(editing ? seedKey : '');
    setAuthPassword('');
    setRemovePassword(false);
    setMasterPassword('');
  }, [state, seedUser, seedPort, seedKey]);

  const target = movingHost
    ? normalizeGroupPath(parent)
    : normalizeGroupPath(folderPath([...folderSegments(parent), sanitizeFolderName(name)]));
  const problem = movingHost ? undefined : folderTargetProblem(sourcePath, target);
  // Exact comparison, not folder identity: two paths that differ only in case
  // are the same folder, but changing its capitalisation is still a rename and
  // has to be written out, or the old spelling stays on screen.
  const renaming = mode === 'edit' && !!sourcePath && target !== normalizeGroupPath(sourcePath);
  const affected = useMemo(
    () => (renaming ? folderRewritePlan(allHosts, sourcePath, target) : []),
    [renaming, allHosts, sourcePath, target],
  );
  const merging = useMemo(
    () =>
      renaming &&
      knownFolderPaths(config?.hosts ?? [], savedData?.profiles ?? [], emptyFolders).some(
        // Recapitalising a folder lands on itself, which is not a merge.
        (path) => isSamePath(path, target) && !isSamePath(path, sourcePath),
      ),
    [renaming, config?.hosts, savedData?.profiles, emptyFolders, target, sourcePath],
  );

  const portNumber = authPort.trim() === '' ? undefined : Number(authPort.trim());
  const portInvalid =
    portNumber !== undefined &&
    !(Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535);
  const vaultConfigured = vaultStatus?.configured ?? false;
  const passwordNeedsMaster =
    vaultConfigured && (vaultStatus?.locked ?? false) && authPassword.length > 0;

  if (state === false) return null;

  const close = () => setState(false);

  /** Write the credential fields for `path`, after moving them off `previousPath`. */
  const persistCredentials = (path: string, previousPath?: string) => {
    const auth: FolderAuthSettings = {
      ...(authUser.trim() ? { user: authUser.trim() } : {}),
      ...(portNumber !== undefined && !portInvalid ? { port: portNumber } : {}),
      // A folder key means "log in with exactly this key", like the host
      // editor's specific-key mode.
      ...(authKey.trim() ? { identityFiles: [authKey.trim()], identitiesOnly: true } : {}),
    };
    const password = authPassword
      ? authPassword
      : removePassword && settingsRecord?.hasPassword
        ? null
        : undefined;
    const dirty = !!settingsRecord || Object.keys(auth).length > 0 || password !== undefined;
    const save = () => {
      if (!dirty) return;
      saveSettings.mutate({
        path,
        auth,
        password,
        ...(masterPassword.trim() ? { masterPassword: masterPassword.trim() } : {}),
      });
    };
    if (previousPath && hasFolderSettingsUnder(settingsData?.folders, previousPath)) {
      void moveSettings
        .mutateAsync({ from: previousPath, to: path })
        .then(save)
        .catch(() => undefined);
      return;
    }
    save();
  };

  const submit = () => {
    if (movingHost) {
      const host = allHosts.find((entry) => managedHostKey(entry) === movingHost.hostKey);
      if (host) {
        applyMoves.mutate({ moves: [moveHostPlan(host, target)], label: movingHost.hostName });
      }
      close();
      return;
    }
    if (problem || portInvalid || (passwordNeedsMaster && !masterPassword.trim())) return;

    if (mode === 'new') {
      folders.addEmptyFolder(target);
      folders.setFolderStyle(folderKey(target), { color, icon });
      persistCredentials(target);
      close();
      return;
    }

    // Style first: it is local and instant, so the folder keeps its look while
    // the hosts underneath it are still moving.
    folders.setFolderStyle(folderKey(renaming ? target : sourcePath), { color, icon });
    if (renaming) {
      folders.renameFolderPrefs(sourcePath, target);
      // The rename above already carried the empty-folder markers over. Clearing
      // the old path is only safe when it is a different folder: paths match
      // case-insensitively, so after a recapitalisation it would take the marker
      // it just rewrote — and every marker below it — with it.
      if (!isSamePath(sourcePath, target)) folders.removeEmptyFolder(sourcePath);
      if (affected.length > 0) applyMoves.mutate({ moves: affected, label: target });
      else folders.addEmptyFolder(target);
      persistCredentials(target, sourcePath);
      showToast('success', `Folder renamed to “${target}”.`);
    } else {
      persistCredentials(normalizeGroupPath(sourcePath));
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

                <Divider sx={{ mt: 0.5 }} />
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Shared SSH credentials
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Hosts in this folder use these unless they set their own.
                    Anything in your ssh config still wins, and the nearest
                    folder beats its parents.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1.5}>
                  <TextField
                    label="Username"
                    value={authUser}
                    onChange={(event) => setAuthUser(event.target.value)}
                    placeholder="from ssh config"
                    fullWidth
                  />
                  <TextField
                    label="Port"
                    value={authPort}
                    onChange={(event) => setAuthPort(event.target.value)}
                    placeholder="22"
                    error={portInvalid}
                    sx={{ width: 130 }}
                  />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <Autocomplete
                    freeSolo
                    fullWidth
                    options={sshKeys?.keys ?? []}
                    getOptionLabel={(option) =>
                      typeof option === 'string' ? option : option.path
                    }
                    inputValue={authKey}
                    onInputChange={(_event, value) => setAuthKey(value)}
                    renderOption={(props, option) => (
                      <Box component="li" {...props} key={option.path}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2">{option.name}</Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            noWrap
                            sx={{ display: 'block' }}
                          >
                            {option.path}
                          </Typography>
                        </Box>
                      </Box>
                    )}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Private key"
                        placeholder="pick from ~/.ssh or type a path"
                        helperText={
                          authKey.trim()
                            ? 'Hosts without their own key log in with exactly this key.'
                            : undefined
                        }
                      />
                    )}
                  />
                  {window.muxusDesktop && (
                    <Tooltip title="Browse for a key file">
                      <IconButton
                        aria-label="Browse for a key file"
                        onClick={() => {
                          void window.muxusDesktop?.selectPrivateKey().then((path) => {
                            if (path) setAuthKey(path);
                          });
                        }}
                        sx={{ mt: 0.75 }}
                      >
                        <FolderOpenOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
                <TextField
                  label="Shared password"
                  type="password"
                  autoComplete="new-password"
                  value={authPassword}
                  onChange={(event) => {
                    setAuthPassword(event.target.value);
                    if (event.target.value) setRemovePassword(false);
                  }}
                  disabled={!vaultConfigured}
                  placeholder={
                    settingsRecord?.hasPassword && !removePassword ? '•••••••• (saved)' : undefined
                  }
                  helperText={
                    !vaultConfigured
                      ? 'Set up the password vault in Settings → Passwords to store a shared password.'
                      : removePassword
                        ? 'The saved password is removed when you save.'
                        : settingsRecord?.hasPassword
                          ? 'Leave empty to keep the saved password.'
                          : 'Offered when a host falls back to password login; kept in the encrypted vault.'
                  }
                  slotProps={{
                    input: {
                      endAdornment:
                        settingsRecord?.hasPassword && !authPassword ? (
                          <InputAdornment position="end">
                            <Tooltip
                              title={removePassword ? 'Keep the saved password' : 'Remove the saved password'}
                            >
                              <IconButton
                                size="small"
                                aria-label={
                                  removePassword ? 'Keep the saved password' : 'Remove the saved password'
                                }
                                onClick={() => setRemovePassword((value) => !value)}
                              >
                                {removePassword ? (
                                  <UndoOutlinedIcon fontSize="small" />
                                ) : (
                                  <DeleteOutlineIcon fontSize="small" />
                                )}
                              </IconButton>
                            </Tooltip>
                          </InputAdornment>
                        ) : undefined,
                    },
                  }}
                  fullWidth
                />
                {passwordNeedsMaster && (
                  <TextField
                    label="Vault master password"
                    type="password"
                    autoComplete="current-password"
                    value={masterPassword}
                    onChange={(event) => setMasterPassword(event.target.value)}
                    helperText="The password vault is locked — its master password is needed to store this."
                    fullWidth
                  />
                )}
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
            disabled={
              (!movingHost &&
                (!!problem ||
                  portInvalid ||
                  (passwordNeedsMaster && !masterPassword.trim()))) ||
              applyMoves.isPending
            }
          >
            {movingHost ? 'Move' : mode === 'new' ? 'Create' : 'Save'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
