import { useRef, useState, type ChangeEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import type { KeywordHighlightProfile } from '@muxus/shared';
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

export function HighlightProfilesSection() {
  const globalRules = usePrefsStore((state) => state.keywordHighlights);
  const profiles = usePrefsStore((state) => state.keywordHighlightProfiles);
  const setPrefs = usePrefsStore((state) => state.set);
  const importInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState('');
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

  const exportProfile = (profile: KeywordHighlightProfile) => {
    try {
      const document = createHighlightProfileDocument([profile]);
      saveTextFile(
        exportFilename(`${profile.name} highlighting profile`, 'muxus-highlight.json'),
        `${JSON.stringify(document, null, 2)}\n`,
        'application/json',
      );
      showToast('success', `Exported ${profile.name}.`);
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
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
          Global keyword highlighting
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These literal keywords are highlighted in every terminal. A host can include
          these rules and add its assigned profile and own rules, or replace the global
          set entirely.
        </Typography>
        <KeywordHighlightRulesEditor
          rules={globalRules}
          onChange={(keywordHighlights) => setPrefs({ keywordHighlights })}
        />
      </Box>

      <Divider />

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Reusable profiles
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
          Define a platform-specific rule set once, assign it in any host editor, and
          export it to share with another Muxus installation.
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <TextField
            select
            size="small"
            label="Profile"
            value={selectedProfile?.id ?? ''}
            onChange={(event) => setSelectedId(event.target.value)}
            sx={{ minWidth: 240, flex: 1 }}
          >
            {profiles.length === 0 ? (
              <MenuItem value="" disabled>
                No profiles yet
              </MenuItem>
            ) : null}
            {profiles.map((profile) => (
              <MenuItem key={profile.id} value={profile.id}>
                {profile.name} ({profile.rules.length})
              </MenuItem>
            ))}
          </TextField>
          <Button
            startIcon={<AddIcon />}
            disabled={profiles.length >= MAX_KEYWORD_HIGHLIGHT_PROFILES}
            onClick={addProfile}
          >
            New
          </Button>
          <Button startIcon={<UploadFileOutlinedIcon />} onClick={() => importInput.current?.click()}>
            Import
          </Button>
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".muxus-highlight,.json,.muxus-highlight.json,application/json"
            onChange={chooseImport}
          />
        </Stack>
      </Box>

      {selectedProfile ? (
        <Stack spacing={2}>
          <TextField
            fullWidth
            label="Profile name"
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
          />
          <KeywordHighlightRulesEditor
            rules={selectedProfile.rules}
            onChange={(rules) => updateProfile(selectedProfile.id, { rules })}
            emptyMessage="No rules in this profile yet."
          />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              startIcon={<DownloadOutlinedIcon />}
              disabled={!selectedProfile.name.trim()}
              onClick={() => exportProfile(selectedProfile)}
            >
              Export profile
            </Button>
            <Button
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => deleteProfile(selectedProfile)}
            >
              Delete profile
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Create or import a profile to reuse highlighting rules across hosts.
        </Typography>
      )}
    </Stack>
  );
}

function unusedProfileName(profiles: readonly KeywordHighlightProfile[]): string {
  const names = new Set(profiles.map((profile) => profile.name.toLocaleLowerCase()));
  if (!names.has('new profile')) return 'New profile';
  let suffix = 2;
  while (names.has(`new profile ${suffix}`)) suffix++;
  return `New profile ${suffix}`;
}
