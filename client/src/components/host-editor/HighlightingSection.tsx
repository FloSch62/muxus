import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { HostDraft } from './draft.js';
import { KeywordHighlightRulesEditor } from '../KeywordHighlightRulesEditor.js';

export function HighlightingSection({
  draft,
  set,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
}) {
  const config = draft.keywordHighlights;
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Keyword highlighting
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Host rules apply whenever a terminal connects through this OpenSSH alias.
        </Typography>
      </Box>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={config.inheritGlobal}
            onChange={(event) =>
              set({
                keywordHighlights: {
                  ...config,
                  inheritGlobal: event.target.checked,
                },
              })
            }
          />
        }
        label={
          <Box>
            <Typography variant="body2">Include global highlighting rules</Typography>
            <Typography variant="caption" color="text.secondary">
              Turn this off when this host should use only the rules below.
            </Typography>
          </Box>
        }
      />
      <KeywordHighlightRulesEditor
        rules={config.rules}
        onChange={(rules) => set({ keywordHighlights: { ...config, rules } })}
        emptyMessage="No host-specific keyword rules yet."
      />
    </Stack>
  );
}
