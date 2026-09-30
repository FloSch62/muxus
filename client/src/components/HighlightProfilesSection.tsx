import { useRef, useState, type ChangeEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import type { KeywordHighlightProfile } from '@muxus/shared';
import { BUILTIN_HIGHLIGHT_PROFILES } from '../builtin-highlight-profiles.js';
import { newPreferenceId } from '../command-buttons.js';
import {
  MAX_HIGHLIGHT_PROFILE_FILE_BYTES,
  MAX_KEYWORD_HIGHLIGHT_PROFILES,
  createHighlightProfileDocument,
  mergeHighlightProfiles,
  parseHighlightProfileDocument,
} from '../highlight-profiles.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { confirmAction } from '../state/dialogs.js';
import { usePrefsStore } from '../state/prefs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { KeywordHighlightRulesEditor } from './KeywordHighlightRulesEditor.js';
import { RowSelect, SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';

export function HighlightProfilesSection() {
  const globalRules = usePrefsStore((state) => state.keywordHighlights);
  const profiles = usePrefsStore((state) => state.keywordHighlightProfiles);
  const setPrefs = usePrefsStore((state) => state.set);
  const importInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState('');
  const [builtinMenuAnchor, setBuiltinMenuAnchor] = useState<HTMLElement | null>(null);
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedId) ?? profiles[0];

  const updateProfile = (
    id: string,
    patch: Partial<Pick<KeywordHighlightProfile, 'name' | 'rules'>>,
  ) => {
    const current = usePrefsStore.getState().keywordHighlightProfiles;
    setPrefs({
      keywordHighlightProfiles: current.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    });
  };

  const addProfile = () => {
    const current = usePrefsStore.getState().keywordHighlightProfiles;
    if (current.length >= MAX_KEYWORD_HIGHLIGHT_PROFILES) {
      showToast(
        'error',
        `Muxus supports up to ${MAX_KEYWORD_HIGHLIGHT_PROFILES} highlighting profiles. Delete one before creating another.`,
      );
      return;
    }
    const profile: KeywordHighlightProfile = {
      id: newPreferenceId('highlight-profile'),
      name: unusedProfileName(current),
      rules: [],
    };
    setPrefs({ keywordHighlightProfiles: [...current, profile] });
    setSelectedId(profile.id);
  };

  const deleteProfile = (profile: KeywordHighlightProfile) => {
    void confirmAction({
      title: `Delete ${profile.name}?`,
      description:
        'Hosts assigned to this profile will stop receiving its shared rules. Their own rules are not changed.',
      confirmLabel: 'Delete profile',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      const current = usePrefsStore.getState().keywordHighlightProfiles;
      usePrefsStore.getState().set({
        keywordHighlightProfiles: current.filter((candidate) => candidate.id !== profile.id),
      });
      setSelectedId('');
    });
  };

  // Merging by ID adds a missing built-in, or resets an installed one in place
  // so hosts assigned to it keep following it.
  const installBuiltinProfile = (builtin: KeywordHighlightProfile) => {
    setBuiltinMenuAnchor(null);
    const install = () => {
      try {
        const current = usePrefsStore.getState().keywordHighlightProfiles;
        usePrefsStore.getState().set({
          keywordHighlightProfiles: mergeHighlightProfiles(current, [builtin]),
        });
        setSelectedId(builtin.id);
      } catch (error) {
        showErrorToast(error);
      }
    };
    if (!profiles.some((profile) => profile.id === builtin.id)) {
      install();
      return;
    }
    void confirmAction({
      title: `Reset ${builtin.name}?`,
      description:
        'Its name and rules are replaced with the defaults shipped with Muxus. Hosts assigned to it keep the assignment.',
      confirmLabel: 'Reset profile',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) install();
    });
  };

  const exportProfiles = (
    selection: KeywordHighlightProfile[],
    filenameTitle: string,
    message: string,
  ) => {
    try {
      const document = createHighlightProfileDocument(selection);
      saveTextFile(
        exportFilename(filenameTitle, 'muxus-highlight.json'),
        `${JSON.stringify(document, null, 2)}\n`,
        'application/json',
      );
      showToast('success', message);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const importProfiles = async (file: File) => {
    if (file.size > MAX_HIGHLIGHT_PROFILE_FILE_BYTES) {
      showToast('error', 'That highlighting profile file is too large.');
      return;
    }
    try {
      const document = parseHighlightProfileDocument(await file.text());
      const current = usePrefsStore.getState().keywordHighlightProfiles;
      usePrefsStore.getState().set({
        keywordHighlightProfiles: mergeHighlightProfiles(current, document.profiles),
      });
      setSelectedId(document.profiles[0]?.id ?? '');
      showToast(
        'success',
        `Imported ${document.profiles.length} highlighting profile${document.profiles.length === 1 ? '' : 's'}. Matching IDs were updated.`,
      );
    } catch (error) {
      showErrorToast(error);
    }
  };

  const chooseImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importProfiles(file);
  };

  return (
    <SettingsPage
      title="Highlighting"
      description="Keywords and regular expressions to color in terminal output."
    >
      <SettingsGroup
        title="Global rules"
        description="Highlighted in every terminal. A host can include these rules and add its assigned profile and own rules, or replace the global set entirely."
        flush
      >
        <Box sx={{ p: 2 }}>
          <KeywordHighlightRulesEditor
            rules={globalRules}
            onChange={(keywordHighlights) => setPrefs({ keywordHighlights })}
          />
        </Box>
      </SettingsGroup>

      <SettingsGroup
        title={profiles.length ? `Reusable profiles · ${profiles.length}` : 'Reusable profiles'}
        description="Define a platform-specific rule set once, assign it in any host editor, and export it to share with another Muxus installation. Profiles for Nokia SR OS and SR Linux output are included; edit them freely, or reset them from Built-in."
        action={
          <>
            <Button
              size="small"
              startIcon={<AddIcon />}
              disabled={profiles.length >= MAX_KEYWORD_HIGHLIGHT_PROFILES}
              onClick={addProfile}
            >
              New
            </Button>
            <Button
              size="small"
              startIcon={<LibraryAddOutlinedIcon />}
              aria-haspopup="menu"
              onClick={(event) => setBuiltinMenuAnchor(event.currentTarget)}
            >
              Built-in
            </Button>
            <Button
              size="small"
              startIcon={<UploadFileOutlinedIcon />}
              onClick={() => importInput.current?.click()}
            >
              Import
            </Button>
          </>
        }
      >
        <Menu
          open={!!builtinMenuAnchor}
          anchorEl={builtinMenuAnchor}
          onClose={() => setBuiltinMenuAnchor(null)}
        >
          {BUILTIN_HIGHLIGHT_PROFILES.map((builtin) => (
            <MenuItem key={builtin.id} onClick={() => installBuiltinProfile(builtin)}>
              <ListItemText
                primary={builtin.name}
                secondary={
                  profiles.some((profile) => profile.id === builtin.id)
                    ? 'Reset to the shipped rules'
                    : 'Add to your profiles'
                }
              />
            </MenuItem>
          ))}
        </Menu>
        <input
          ref={importInput}
          hidden
          type="file"
          accept=".muxus-highlight,.json,.muxus-highlight.json,application/json"
          onChange={chooseImport}
        />
        {selectedProfile ? (
          <>
            <SettingRow
              label="Profile"
              description="The profile to edit below."
              control={
                <RowSelect
                  id="settings-highlight-profile"
                  label="Profile"
                  width={260}
                  value={selectedProfile.id}
                  onChange={setSelectedId}
                  options={profiles.map(
                    (profile) => [profile.id, `${profile.name} (${profile.rules.length})`] as const,
                  )}
                />
              }
            />
            <SettingRow
              label="Name"
              labelFor="settings-highlight-profile-name"
              control={
                <TextField
                  id="settings-highlight-profile-name"
                  value={selectedProfile.name}
                  onChange={(event) =>
                    updateProfile(selectedProfile.id, { name: event.target.value })
                  }
                  onBlur={() => {
                    if (!selectedProfile.name.trim()) {
                      updateProfile(selectedProfile.id, { name: 'Untitled profile' });
                    }
                  }}
                  slotProps={{ htmlInput: { maxLength: 200 } }}
                  sx={{ width: 260 }}
                />
              }
            />
            <Box className="settings-row" sx={{ p: 2 }}>
              {/* Keyed so unapplied JSON never carries over to another profile. */}
              <KeywordHighlightRulesEditor
                key={selectedProfile.id}
                rules={selectedProfile.rules}
                onChange={(rules) => updateProfile(selectedProfile.id, { rules })}
                emptyMessage="No rules in this profile yet."
              />
            </Box>
            <Stack
              className="settings-row"
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap', px: 2, py: 1.25 }}
            >
              <Button
                variant="outlined"
                startIcon={<DownloadOutlinedIcon />}
                disabled={!selectedProfile.name.trim()}
                onClick={() =>
                  exportProfiles(
                    [selectedProfile],
                    `${selectedProfile.name} highlighting profile`,
                    `Exported ${selectedProfile.name}.`,
                  )
                }
              >
                Export profile
              </Button>
              {profiles.length > 1 ? (
                <Button
                  startIcon={<DownloadOutlinedIcon />}
                  onClick={() =>
                    exportProfiles(
                      profiles,
                      'highlighting profiles',
                      `Exported ${profiles.length} highlighting profiles.`,
                    )
                  }
                >
                  Export all
                </Button>
              ) : null}
              <Button
                color="error"
                startIcon={<DeleteOutlineIcon />}
                onClick={() => deleteProfile(selectedProfile)}
                sx={{ ml: 'auto' }}
              >
                Delete profile
              </Button>
            </Stack>
          </>
        ) : (
          <Typography variant="body2" color="textSecondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            No profiles yet. Create, import or add a built-in profile to reuse highlighting rules
            across hosts.
          </Typography>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

function unusedProfileName(profiles: readonly KeywordHighlightProfile[]): string {
  const names = new Set(profiles.map((profile) => profile.name.toLocaleLowerCase()));
  if (!names.has('new profile')) return 'New profile';
  let suffix = 2;
  while (names.has(`new profile ${suffix}`)) suffix++;
  return `New profile ${suffix}`;
}
