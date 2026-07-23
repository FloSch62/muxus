import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import type { SshConfigResponse } from '@muxus/shared';
import type { HostDraft } from './draft.js';
import { draftAliases } from './draft.js';

/**
 * The ProxyJump chain builder: a visual path from this computer through each
 * jump host to the target, plus an ordered editable hop list. Hops can be
 * config aliases (picked from a list) or ad-hoc user@host:port specs.
 */
export function RouteSection({
  draft,
  set,
  config,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  config: SshConfigResponse | undefined;
}) {
  const [pending, setPending] = useState('');
  const self = new Set(draftAliases(draft));
  const aliasOptions = (config?.hosts ?? []).map((h) => h.alias).filter((a) => !self.has(a) && !draft.proxyJump.includes(a));
  const target = draftAliases(draft)[0] || draft.hostname || 'target';

  const move = (i: number, dir: -1 | 1) => {
    const hops = [...draft.proxyJump];
    const j = i + dir;
    if (j < 0 || j >= hops.length) return;
    [hops[i], hops[j]] = [hops[j]!, hops[i]!];
    set({ proxyJump: hops });
  };

  const add = (value: string) => {
    const v = value.trim();
    if (!v || /[\s,]/.test(v) || draft.proxyJump.includes(v)) return;
    set({ proxyJump: [...draft.proxyJump, v] });
    setPending('');
  };

  const knownAlias = (hop: string) => (config?.hosts ?? []).some((h) => h.aliases.includes(hop));

  return (
    <Stack spacing={2.5}>
      {/* Visual path */}
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" icon={<ComputerOutlinedIcon />} label="This computer" variant="outlined" />
        <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
        {draft.proxyJump.map((hop) => (
          <Stack key={hop} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Tooltip title={knownAlias(hop) ? 'Jump host from your config' : 'Ad-hoc jump host'}>
              <Chip size="small" icon={<DnsOutlinedIcon />} label={hop} color="primary" variant="outlined" />
            </Tooltip>
            <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          </Stack>
        ))}
        <Chip size="small" icon={<DnsOutlinedIcon />} label={target} />
      </Stack>

      {draft.proxyJump.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Direct connection. Add a jump host to reach {target} through a bastion — each hop is authenticated and verified in its own
          right, and its own config (keys, user, port) applies.
        </Typography>
      )}

      {/* Editable hop list */}
      {draft.proxyJump.length > 0 && (
        <Stack spacing={0.5}>
          {draft.proxyJump.map((hop, i) => (
            <Stack key={`${hop}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography sx={{ width: 20, textAlign: 'right', fontSize: 12, color: 'text.disabled' }}>{i + 1}.</Typography>
              <Typography sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 13 }}>{hop}</Typography>
              <IconButton size="small" aria-label={`Move ${hop} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUpwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <IconButton size="small" aria-label={`Move ${hop} later`} disabled={i === draft.proxyJump.length - 1} onClick={() => move(i, 1)}>
                <ArrowDownwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <IconButton size="small" aria-label={`Remove ${hop}`} onClick={() => set({ proxyJump: draft.proxyJump.filter((_, j) => j !== i) })}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Autocomplete
          freeSolo
          fullWidth
          options={aliasOptions}
          inputValue={pending}
          onInputChange={(_e, v) => setPending(v)}
          onChange={(_e, v) => {
            if (typeof v === 'string') add(v);
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Add jump host"
              placeholder="alias from config, or user@host:port"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pending.trim()) {
                  e.preventDefault();
                  add(pending);
                }
              }}
            />
          )}
        />
        <Box sx={{ pt: 0.5 }}>
          <IconButton aria-label="Add jump host" onClick={() => add(pending)} disabled={!pending.trim()}>
            <AddIcon />
          </IconButton>
        </Box>
      </Stack>
    </Stack>
  );
}
