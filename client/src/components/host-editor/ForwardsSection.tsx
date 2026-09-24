import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import type { X11Availability } from '@muxus/shared';
import { useAppInfo } from '../../api/queries.js';
import { FORWARD_FLAG, ForwardRuleForm, describeForward } from '../ForwardRuleForm.js';
import type { ForwardX11Mode, HostDraft } from './draft.js';
import { draftAliases } from './draft.js';

/**
 * X11 forwarding plus the port forwards written to the Host block
 * (LocalForward / RemoteForward / DynamicForward) — they start automatically
 * with every session, and the live diagram explains the selected tunnel type.
 */
export function ForwardsSection({ draft, set }: { draft: HostDraft; set: (patch: Partial<HostDraft>) => void }) {
  const serverLabel = draftAliases(draft)[0] || draft.hostname || 'SSH server';
  const info = useAppInfo().data;
  const configBacked = draft.storage === 'openssh';

  return (
    <Stack spacing={2}>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="subtitle2">Graphical applications (X11)</Typography>
          <Typography variant="caption" color="text.secondary">
            Show the windows of remote GUI programs on this computer.
          </Typography>
        </Box>
        <TextField
          select
          label="X11 forwarding"
          value={draft.forwardX11}
          onChange={(e) => set({ forwardX11: e.target.value as ForwardX11Mode })}
          helperText={info ? x11Help(draft.forwardX11, info.x11, info.platform, configBacked) : undefined}
          fullWidth
        >
          <MenuItem value="inherit">
            {configBacked ? 'Use SSH configuration' : 'Automatic'}
          </MenuItem>
          <MenuItem value="yes">Forward X11</MenuItem>
          <MenuItem value="no">Do not forward X11</MenuItem>
        </TextField>
      </Stack>
      <Divider />
      <Typography variant="subtitle2">Port forwards</Typography>
      <ForwardRuleForm serverLabel={serverLabel} onAdd={(rule) => set({ forwards: [...draft.forwards, rule] })} />
      <Divider />
      {draft.forwards.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {configBacked
            ? 'No forwards configured. Rules added here are written to the Host block and start with every connection.'
            : 'No forwards configured. Rules added here are stored in Muxus and start with every connection.'}
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {draft.forwards.map((f, i) => (
            <Stack key={`${f.type}-${f.bindPort}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip size="small" label={FORWARD_FLAG[f.type]} sx={{ fontFamily: '"JetBrains Mono", monospace', width: 44 }} />
              <Typography variant="body2" sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>
                {describeForward(f)}
              </Typography>
              <Tooltip title="Remove rule">
                <IconButton size="small" aria-label="Remove forward" onClick={() => set({ forwards: draft.forwards.filter((_, j) => j !== i) })}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function x11Help(
  mode: ForwardX11Mode,
  x11: X11Availability,
  platform: string,
  configBacked: boolean,
): string {
  if (mode === 'no') return 'Muxus never requests X11 forwarding for this host.';
  if (x11.source === 'none') {
    return platform === 'darwin'
      ? 'No X server found. Install XQuartz from xquartz.org, then log out and back in.'
      : 'No local X server found, so X11 forwarding is unavailable.';
  }
  const trust =
    'Forwarded programs can see other X11 windows on your desktop, so use this only for hosts you trust.';
  if (mode === 'yes') {
    return x11.source === 'bundled'
      ? 'Remote windows open through the X server built into Muxus.'
      : `Remote windows open on display ${x11.display ?? ''}. ${trust}`;
  }
  const fallback = x11.source === 'bundled'
    ? 'on — Muxus includes its own X server'
    : 'off — forwarded programs can watch other X11 windows on your desktop';
  return configBacked
    ? `Uses ForwardX11 from matching SSH configuration; otherwise ${fallback}.`
    : `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)}.`;
}
