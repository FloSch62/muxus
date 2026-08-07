import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernet';
import { DIAL_TIME_KEYWORDS } from '@muxus/shared';
import { useAppInfo } from '../../api/queries.js';
import { applyLegacyPreset, legacyPresetState, unsupportedEntries } from './advanced-options.js';
import type { HostDraft } from './draft.js';

/**
 * Everything ssh_config knows that Muxus doesn't model as a field: free-form
 * option rows (kept verbatim through edits), plus the live preview of the
 * exact block text a save writes — rendered by the server so it can't drift.
 * Rows are badged by whether the dialer applies the keyword or merely
 * preserves it for OpenSSH, and algorithm values the SSH engine can't offer
 * are flagged as they are typed instead of at connect time.
 */
export function AdvancedSection({
  draft,
  set,
  preview,
  previewError,
  configBacked = true,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  preview: string;
  previewError: string | null;
  configBacked?: boolean;
}) {
  const sshAlgorithms = useAppInfo().data?.sshAlgorithms;
  const legacyState = legacyPresetState(draft.extras);

  const update = (i: number, patch: Partial<{ keyword: string; value: string }>) =>
    set({ extras: draft.extras.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">Console compatibility</Typography>
        <FormControlLabel
          control={
            <Switch
              checked={draft.consoleCompatibility}
              onChange={(event) => set({ consoleCompatibility: event.target.checked })}
            />
          }
          label="Enable console compatibility mode"
        />
        <Typography variant="body2" color="text.secondary">
          Skips SFTP, shell integration, and SendEnv/SetEnv requests. TTY settings still apply.
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={draft.disableSftp}
              onChange={(event) => set({ disableSftp: event.target.checked })}
            />
          }
          label="Disable SFTP and shell integration only"
        />
        <Typography variant="body2" color="text.secondary">
          Keeps SendEnv/SetEnv and normal TTY behavior. Console mode already disables SFTP and
          shell integration, regardless of this setting.
        </Typography>
      </Stack>

      {configBacked ? (
        <Stack spacing={1}>
          <Typography variant="body2" color="text.secondary">
            Additional ssh_config options. Applied options are used by Muxus; others are
            preserved for OpenSSH.
          </Typography>
          {draft.extras.map((e, i) => {
            const keyword = e.keyword.trim().toLowerCase();
            const unsupported = unsupportedEntries(e.keyword, e.value, sshAlgorithms);
            return (
              <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Option"
                  value={e.keyword}
                  onChange={(ev) => update(i, { keyword: ev.target.value })}
                  sx={{ width: 180, flexShrink: 0 }}
                />
                <TextField
                  label="Value"
                  value={e.value}
                  onChange={(ev) => update(i, { value: ev.target.value })}
                  fullWidth
                  error={unsupported.length > 0}
                  helperText={
                    unsupported.length
                      ? `Skipped when connecting — not supported by the SSH engine: ${unsupported.join(', ')}`
                      : undefined
                  }
                />
                <Box sx={{ width: 62, flexShrink: 0, display: 'flex', justifyContent: 'center', pt: 1.25 }}>
                  {keyword &&
                    (DIAL_TIME_KEYWORDS.has(keyword) ? (
                      <Tooltip title="Muxus applies this option when connecting.">
                        <Chip size="small" label="applied" color="success" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                      </Tooltip>
                    ) : (
                      <Tooltip title="Kept in the config for OpenSSH — Muxus does not use this option.">
                        <Chip size="small" label="kept" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.secondary' }} />
                      </Tooltip>
                    ))}
                </Box>
                <IconButton size="small" aria-label="Remove option" sx={{ mt: 0.75 }} onClick={() => set({ extras: draft.extras.filter((_, j) => j !== i) })}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}
          <Stack direction="row" spacing={1}>
            <Button size="small" startIcon={<AddIcon />} onClick={() => set({ extras: [...draft.extras, { keyword: '', value: '' }] })}>
              Add option
            </Button>
            <Tooltip
              title={
                legacyState === 'conflict'
                  ? 'An algorithm list uses a removal (-) policy the preset will not rewrite. Adjust the lists manually.'
                  : 'Adds the key exchange, host key and cipher options old console servers and network gear need. Merged into the modern defaults, so current hosts keep working.'
              }
            >
              <span>
                <Button
                  size="small"
                  startIcon={<SettingsEthernetIcon />}
                  disabled={legacyState === 'enabled' || legacyState === 'conflict'}
                  onClick={() => set({ extras: applyLegacyPreset(draft.extras) })}
                >
                  Legacy device algorithms
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
      ) : null}

      {configBacked ? (
        <Stack spacing={0.75}>
          <Typography variant="body2" color="text.secondary">
            This is written to the config:
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              borderRadius: 1,
              border: 1,
              borderColor: previewError ? 'error.main' : 'divider',
              bgcolor: 'action.hover',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: 'auto',
              minHeight: 72,
              whiteSpace: 'pre',
            }}
          >
            {previewError ?? preview ?? ''}
          </Box>
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Raw ssh_config options are only available when a host is stored in OpenSSH
          config. The connection settings in the other sections are stored directly by
          Muxus.
        </Typography>
      )}
    </Stack>
  );
}
