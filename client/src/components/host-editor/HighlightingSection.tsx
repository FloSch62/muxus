import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { HostKeywordHighlightConfig } from '@muxus/shared';
import { usePrefsStore } from '../../state/prefs.js';
import { KeywordHighlightRulesEditor } from '../KeywordHighlightRulesEditor.js';

export function HighlightingSection({
  config,
  onChange,
  description = 'Host rules apply whenever a terminal connects through this OpenSSH alias.',
}: {
  config: HostKeywordHighlightConfig;
  onChange: (config: HostKeywordHighlightConfig) => void;
  description?: string;
}) {
  const profiles = usePrefsStore((state) => state.keywordHighlightProfiles);
  const selectedProfile = config.profileId
    ? profiles.find((profile) => profile.id === config.profileId)
    : undefined;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Keyword highlighting
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
      </Box>
      <TextField
        select
        fullWidth
        label="Highlighting profile"
        value={config.profileId ?? ''}
        onChange={(event) =>
          onChange({
            ...config,
            profileId: event.target.value || undefined,
          })
        }
        helperText={
          selectedProfile
            ? `${selectedProfile.rules.length} shared rule${selectedProfile.rules.length === 1 ? '' : 's'}; edit it in Settings → Highlighting.`
            : 'Optional named rule set shared by several hosts.'
        }
      >
        <MenuItem value="">No reusable profile</MenuItem>
        {config.profileId && !selectedProfile ? (
          <MenuItem value={config.profileId}>
            Missing profile ({config.profileId})
          </MenuItem>
        ) : null}
        {profiles.map((profile) => (
          <MenuItem key={profile.id} value={profile.id}>
            {profile.name}
          </MenuItem>
        ))}
      </TextField>
      {config.profileId && !selectedProfile ? (
        <Alert severity="warning" variant="outlined">
          This host references a profile that is not installed. Import it again or choose
          another profile.
        </Alert>
      ) : null}
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={config.inheritGlobal}
            onChange={(event) =>
              onChange({ ...config, inheritGlobal: event.target.checked })
            }
          />
        }
        label={
          <Box>
            <Typography variant="body2">Include global highlighting rules</Typography>
            <Typography variant="caption" color="text.secondary">
              Turn this off when this host should use only its profile and host rules.
            </Typography>
          </Box>
        }
      />
      <KeywordHighlightRulesEditor
        rules={config.rules}
        onChange={(rules) => onChange({ ...config, rules })}
        emptyMessage="No additional host-specific keyword rules."
      />
    </Stack>
  );
}
