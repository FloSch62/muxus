import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import { useCallback, useEffect, useState } from 'react';
import { useAppInfo, useWslDistributions } from '../api/queries.js';
import { saveWslShellProfile } from '../local-shell-launchers.js';
import {
  newLocalShellProfileId,
  opensWslDistribution,
  parseLocalShellArgumentText,
  wslShellProfile,
} from '../local-shell-profile.js';
import { confirmAction } from '../state/dialogs.js';
import {
  usePrefsStore,
  type LocalShellProfileConfig,
} from '../state/prefs.js';
import { LocalShellIcon } from './LocalShellIcon.js';
import { RowSelect, SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';

/** How long the entry the section was opened for stays outlined. */
const HIGHLIGHT_MS = 2500;
const HIGHLIGHT_SX = { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 };

/**
 * The entry the section was opened for, from a sidebar row's menu: scrolled
 * into view once it renders, and outlined for a moment so it is easy to spot.
 */
function useFocusedEntry(focusItem: string | undefined) {
  const [highlighted, setHighlighted] = useState(focusItem);
  useEffect(() => {
    setHighlighted(focusItem);
    if (!focusItem) return;
    const timer = window.setTimeout(() => setHighlighted(undefined), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focusItem]);
  const reveal = useCallback((element: HTMLElement | null) => {
    element?.scrollIntoView({ block: 'center' });
  }, []);
  return (id: string) => ({
    ref: id === focusItem ? reveal : undefined,
    sx: id === highlighted ? HIGHLIGHT_SX : {},
  });
}

export function LocalShellProfilesSection({ focusItem }: { focusItem?: string }) {
  const focus = useFocusedEntry(focusItem);
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
    const id = newLocalShellProfileId(profiles.length);
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
    <SettingsPage
      title="Local shells"
      description="The shells Muxus starts on this computer. Every saved profile is also available in the quick launcher."
    >
      <SettingsGroup title="Default">
        <SettingRow
          label="Default profile"
          description="Used by the sidebar, the empty-pane shortcut and the generic “New local terminal” action."
          control={
            <RowSelect
              id="settings-default-local-shell"
              label="Default profile"
              width={260}
              value={selectedDefault}
              onChange={(value) => setPrefs({ defaultLocalShellProfileId: value })}
              options={[
                ['', 'Automatic shell'],
                ...profiles.map(
                  (profile) => [profile.id, profile.name.trim() || 'Unnamed shell'] as const,
                ),
              ]}
            />
          }
        />
        <SettingRow
          label="Automatic shell"
          labelFor="settings-automatic-shell"
          description={
            info
              ? `Used when no saved profile is the default. auto starts your login shell (${info.defaultShell}); an executable name or path overrides it.`
              : 'Used when no saved profile is the default. auto starts your login shell; an executable name or path overrides it.'
          }
          control={
            <TextField
              id="settings-automatic-shell"
              value={localShell}
              onChange={(event) => setPrefs({ localShell: event.target.value.slice(0, 4096) })}
              placeholder="auto"
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
              sx={{ width: 260 }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title={profiles.length ? `Saved profiles · ${profiles.length}` : 'Saved profiles'}
        description="Separate profiles for PowerShell, Command Prompt, WSL distributions or project-specific shells."
        action={
          <Button size="small" startIcon={<AddIcon />} onClick={addProfile}>
            Add profile
          </Button>
        }
        flush
      >
        {profiles.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            No saved profiles yet. The automatic shell keeps working as before.
          </Typography>
        ) : (
          profiles.map((profile) => {
            const entry = focus(profile.id);
            return (
              <Box
                key={profile.id}
                ref={entry.ref}
                sx={{
                  p: 2,
                  '& + &': { borderTop: 1, borderColor: 'divider' },
                  ...entry.sx,
                }}
              >
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
                        sx={{ mt: 0.25 }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
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
                    slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
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
              </Box>
            );
          })
        )}
      </SettingsGroup>

      {info?.platform === 'win32' && <WslDistributionsSection focus={focus} />}
    </SettingsPage>
  );
}

/** Installed WSL distributions: listed wherever a local terminal can be
 * launched, and one click away from a saved profile that can be customized
 * or made the default. */
function WslDistributionsSection({
  focus,
}: {
  focus: ReturnType<typeof useFocusedEntry>;
}) {
  const profiles = usePrefsStore((state) => state.localShellProfiles);
  const showWslDistributions = usePrefsStore((state) => state.showWslDistributions);
  const setPrefs = usePrefsStore((state) => state.set);
  const { data, isPending, isError } = useWslDistributions();
  const distributions = data?.distributions ?? [];

  return (
    <SettingsGroup title="WSL distributions">
      <SettingRow
        label="List installed distributions"
        labelFor="settings-show-wsl"
        description="Each one appears below Local terminal in the sidebar and in the quick launcher, opening in its Linux home directory. Save one as a profile to change how it starts or to make it the default."
        control={
          <Switch
            id="settings-show-wsl"
            size="small"
            checked={showWslDistributions}
            onChange={(event) => setPrefs({ showWslDistributions: event.target.checked })}
          />
        }
      />
      {isPending || isError || distributions.length === 0 ? (
        <Typography
          className="settings-row"
          variant="body2"
          color="textSecondary"
          sx={{ px: 2, py: 1.5 }}
        >
          {isPending
            ? 'Looking for WSL distributions…'
            : isError
              ? 'The installed distributions could not be read.'
              : 'No WSL distributions are installed.'}
        </Typography>
      ) : (
        distributions.map((distribution) => {
          const saved = profiles.find((profile) =>
            opensWslDistribution(profile, distribution.name),
          );
          const launch = wslShellProfile(distribution);
          const entry = focus(launch.id);
          return (
            <Stack
              key={distribution.name}
              ref={entry.ref}
              className="settings-row"
              direction="row"
              spacing={1.5}
              sx={{ alignItems: 'center', px: 2, py: 1.25, ...entry.sx }}
            >
              <LocalShellIcon
                launch={launch}
                size={20}
                fallback={<TerminalIcon fontSize="small" sx={{ color: 'text.secondary' }} />}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 550 }}>
                  {distribution.name}
                </Typography>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  noWrap
                  sx={{ display: 'block' }}
                >
                  {distribution.isDefault ? 'Default distribution · ' : ''}
                  {[launch.shell, ...launch.args].join(' ')}
                </Typography>
              </Box>
              {saved ? (
                <Typography variant="caption" color="textSecondary" noWrap>
                  Saved as “{saved.name.trim() || 'Unnamed shell'}”
                </Typography>
              ) : (
                <Button size="small" onClick={() => saveWslShellProfile(launch)}>
                  Save as profile
                </Button>
              )}
            </Stack>
          );
        })
      )}
    </SettingsGroup>
  );
}
