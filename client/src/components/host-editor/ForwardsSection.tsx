import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { FORWARD_FLAG, ForwardRuleForm, describeForward } from '../ForwardRuleForm.js';
import type { HostDraft } from './draft.js';
import { draftAliases } from './draft.js';

/**
 * Port forwards written to the Host block (LocalForward / RemoteForward /
 * DynamicForward) — they start automatically with every session, and the
 * live diagram explains the selected tunnel type.
 */
export function ForwardsSection({ draft, set }: { draft: HostDraft; set: (patch: Partial<HostDraft>) => void }) {
  const serverLabel = draftAliases(draft)[0] || draft.hostname || 'SSH server';

  return (
    <Stack spacing={2}>
      <ForwardRuleForm serverLabel={serverLabel} onAdd={(rule) => set({ forwards: [...draft.forwards, rule] })} />
      <Divider />
      {draft.forwards.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {draft.storage === 'openssh'
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
