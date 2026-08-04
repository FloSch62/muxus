import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useAppInfo } from '../api/queries.js';
import { parseLocalShellArgumentText } from '../local-shell-profile.js';
import { confirmAction } from '../state/dialogs.js';
import {
  usePrefsStore,
  type LocalShellProfileConfig,
} from '../state/prefs.js';

export function LocalShellProfilesSection() {
  const profiles = usePrefsStore((state) => state.localShellProfiles);
  const defaultProfileId = usePrefsStore((state) => state.defaultLocalShellProfileId);
  const localShell = usePrefsStore((state) => state.localShell);
  const setPrefs = usePrefsStore((state) => state.set);
  const { data: info } = useAppInfo();
  const selectedDefault = profiles.some((profile) => profile.id === defaultProfileId)
    ? defaultProfileId
    : '';

  const updateProfile = (id: string, patch: Partial<LocalShellProfileConfig>) => {
    const current = usePrefsStore.getState();
    setPrefs({
      localShellProfiles: current.localShellProfiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    });
  };

  const addProfile = () => {
    const id = `local-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${profiles.length}`}`;
    const next: LocalShellProfileConfig = {
      id,
      name: `Shell ${profiles.length + 1}`,
      shell: info?.defaultShell ?? '',
      args: [],
      cwd: '',
      startupCommand: '',
    };
    setPrefs({
      localShellProfiles: [...profiles, next],
      defaultLocalShellProfileId: profiles.length === 0 ? id : defaultProfileId,
    });
  };

  const removeProfile = (profile: LocalShellProfileConfig) => {
    void confirmAction({
      title: `Delete “${profile.name}”?`,
      description:
        'Existing tabs and saved workspaces keep their launch settings, but this profile will disappear from new-terminal choices.',
      confirmLabel: 'Delete profile',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      const current = usePrefsStore.getState();
      current.set({
        localShellProfiles: current.localShellProfiles.filter(
          (candidate) => candidate.id !== profile.id,
        ),
        defaultLocalShellProfileId:
          current.defaultLocalShellProfileId === profile.id
            ? ''
            : current.defaultLocalShellProfileId,
      });
    });
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          Default local terminal
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The default is used by the sidebar, the empty-pane shortcut, and the generic “New
          local terminal” action. Every saved profile is also available in the quick launcher.
        </Typography>
        <Stack spacing={2} sx={{ maxWidth: 520 }}>
          <FormControl fullWidth>
            <InputLabel id="default-local-shell-label">Default profile</InputLabel>
            <Select
              labelId="default-local-shell-label"
              label="Default profile"
              value={selectedDefault}
              onChange={(event) =>
                setPrefs({ defaultLocalShellProfileId: event.target.value })
              }
            >
              <MenuItem value="">Automatic / custom executable</MenuItem>
              {profiles.map((profile) => (
                <MenuItem key={profile.id} value={profile.id}>
                  {profile.name.trim() || 'Unnamed shell'}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Automatic/custom executable"
            value={localShell}
            onChange={(event) => setPrefs({ localShell: event.target.value.slice(0, 4096) })}
            placeholder="auto"
            helperText={
              info
                ? `Used when no saved profile is selected; auto = ${info.defaultShell}`
                : 'Used when no saved profile is selected; auto = your login shell'
            }
            fullWidth
          />
        </Stack>
      </Box>

      <Divider />

      <Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Saved shell profiles
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Use separate profiles for PowerShell, Command Prompt, WSL distributions, or
              project-specific shells.
            </Typography>
          </Box>
          <Button startIcon={<AddIcon />} variant="outlined" onClick={addProfile}>
            Add profile
          </Button>
        </Stack>

        {profiles.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2.5, mt: 2, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No saved profiles yet. The automatic shell continues to work as before.
            </Typography>
          </Paper>
        ) : (
          <Stack spacing={2} sx={{ mt: 2 }}>
            {profiles.map((profile) => (
              <Paper key={profile.id} variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <TextField
                      label="Profile name"
                      value={profile.name}
                      onChange={(event) =>
                        updateProfile(profile.id, { name: event.target.value.slice(0, 200) })
                      }
                      error={!profile.name.trim()}
                      helperText={!profile.name.trim() ? 'Enter a name.' : 'Shown in launch menus'}
                      fullWidth
                    />
                    <Tooltip title="Delete profile">
                      <IconButton
                        aria-label={`Delete ${profile.name || 'shell profile'}`}
                        color="error"
                        onClick={() => removeProfile(profile)}
                        sx={{ mt: 0.75 }}
                      >
                        <DeleteOutlineIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                  <TextField
                    label="Executable"
                    value={profile.shell}
                    onChange={(event) =>
                      updateProfile(profile.id, { shell: event.target.value.slice(0, 4096) })
                    }
                    placeholder={info?.platform === 'win32' ? 'wsl.exe' : '/bin/zsh'}
                    helperText="Executable name or absolute path; blank uses the system default"
                    fullWidth
                  />
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                      gap: 2,
                    }}
                  >
                    <TextField
                      label="Arguments"
                      value={profile.args.join('\n')}
                      onChange={(event) =>
                        updateProfile(profile.id, {
                          args: parseLocalShellArgumentText(event.target.value),
                        })
                      }
                      placeholder={info?.platform === 'win32' ? '-d\nUbuntu' : '--login'}
                      helperText="One argument per line; spaces stay inside that argument"
                      minRows={2}
                      multiline
                      fullWidth
                    />
                    <TextField
                      label="Starting directory"
                      value={profile.cwd}
                      onChange={(event) =>
                        updateProfile(profile.id, { cwd: event.target.value.slice(0, 4096) })
                      }
                      placeholder={info?.homeDir}
                      helperText="Blank starts in your home directory"
                      fullWidth
                    />
                  </Box>
                  <TextField
                    label="Startup commands"
                    value={profile.startupCommand}
                    onChange={(event) =>
                      updateProfile(profile.id, {
                        startupCommand: event.target.value.slice(0, 32_768),
                      })
                    }
                    placeholder="cd project"
                    helperText="Entered automatically after the interactive shell starts; one command per line"
                    minRows={2}
                    multiline
                    fullWidth
                  />
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
