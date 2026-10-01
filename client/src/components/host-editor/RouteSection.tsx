import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
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
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import {
  savedHostHop,
  savedHostHopId,
  type SavedHostProfile,
  type SshConfigResponse,
} from '@muxus/shared';
import { jumpHopLabel, savedHostDisplayName } from '../../saved-hosts.js';
import type { HostDraft } from './draft.js';
import { draftAliases } from './draft.js';

/**
 * Select direct, ProxyJump, or ProxyCommand routing. The jump route includes a
 * visual path and ordered editable hop list. A host stored in Muxus may also
 * jump through other saved Muxus SSH hosts; ssh_config has no way to name one.
 */
export function RouteSection({
  draft,
  set,
  config,
  savedHosts,
  selfProfileId,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  config: SshConfigResponse | undefined;
  savedHosts?: readonly SavedHostProfile[];
  /** The saved host being edited, which cannot be its own jump host. */
  selfProfileId?: string;
}) {
  const [pending, setPending] = useState('');
  const self = new Set(draftAliases(draft));
  const aliasOptions = (config?.hosts ?? []).map((h) => h.alias).filter((a) => !self.has(a) && !draft.proxyJump.includes(a));
  const savedOptions =
    draft.storage === 'muxus'
      ? (savedHosts ?? [])
          .filter((host) => host.profile.kind === 'ssh' && host.id !== selfProfileId)
          .sort((a, b) => savedHostDisplayName(a).localeCompare(savedHostDisplayName(b)))
          .map((host) => savedHostHop(host.id))
          .filter((hop) => !draft.proxyJump.includes(hop))
      : [];
  const hopName = (hop: string) => jumpHopLabel(hop, savedHosts);
  const isSavedHop = (hop: string) => savedHostHopId(hop) !== undefined;
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
      <RadioGroup
        value={draft.routeMode}
        onChange={(e) => set({ routeMode: e.target.value as HostDraft['routeMode'] })}
      >
        <FormControlLabel
          value="direct"
          control={<Radio size="small" />}
          label={<Labeled title="Direct connection" sub="Connect to the target without a proxy" />}
        />
        <FormControlLabel
          value="jump"
          control={<Radio size="small" />}
          label={
            <Labeled
              title="Jump hosts"
              sub={
                draft.storage === 'openssh'
                  ? 'Writes ProxyJump — connect through one or more SSH bastions'
                  : 'Connect through one or more SSH bastions'
              }
            />
          }
        />
        <FormControlLabel
          value="command"
          control={<Radio size="small" />}
          label={
            <Labeled
              title="Proxy command"
              sub={
                draft.storage === 'openssh'
                  ? "Writes ProxyCommand — use a command's stdin/stdout as the transport"
                  : "Use a command's stdin/stdout as the transport"
              }
            />
          }
        />
      </RadioGroup>

      {/* Visual path */}
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" icon={<ComputerOutlinedIcon />} label="This computer" variant="outlined" />
        <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
        {draft.routeMode === 'jump'
          ? draft.proxyJump.map((hop) => (
              <Stack key={hop} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <Tooltip
                  title={
                    isSavedHop(hop)
                      ? 'Jump host saved in Muxus'
                      : knownAlias(hop)
                        ? 'Jump host from your config'
                        : 'Ad-hoc jump host'
                  }
                >
                  <Chip size="small" icon={<DnsOutlinedIcon />} label={hopName(hop)} color="primary" variant="outlined" />
                </Tooltip>
                <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
              </Stack>
            ))
          : null}
        {draft.routeMode === 'command' ? (
          <>
            <Chip size="small" icon={<TerminalOutlinedIcon />} label="ProxyCommand" color="primary" variant="outlined" />
            <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          </>
        ) : null}
        <Chip size="small" icon={<DnsOutlinedIcon />} label={target} />
      </Stack>

      {draft.routeMode === 'direct' ? (
        <Typography variant="body2" color="textSecondary">
          Muxus opens the TCP connection to {target} itself.
        </Typography>
      ) : null}

      {/* Editable hop list */}
      {draft.routeMode === 'jump' ? (
        <Stack spacing={0.5}>
          {draft.proxyJump.map((hop, i) => (
            <Stack key={`${hop}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography sx={{ width: 20, textAlign: 'right', fontSize: 12, color: 'text.disabled' }}>{i + 1}.</Typography>
              <Typography
                sx={{
                  flex: 1,
                  fontSize: 13,
                  ...(isSavedHop(hop) ? {} : { fontFamily: '"JetBrains Mono", monospace' }),
                }}
              >
                {hopName(hop)}
              </Typography>
              <IconButton size="small" aria-label={`Move ${hopName(hop)} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUpwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <IconButton size="small" aria-label={`Move ${hopName(hop)} later`} disabled={i === draft.proxyJump.length - 1} onClick={() => move(i, 1)}>
                <ArrowDownwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <IconButton size="small" aria-label={`Remove ${hopName(hop)}`} onClick={() => set({ proxyJump: draft.proxyJump.filter((_, j) => j !== i) })}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', pt: 1 }}>
            <Autocomplete
              freeSolo
              fullWidth
              // Stays empty after a pick, so the input never refills with the
              // picked host's name and a second Enter can't add it as ad-hoc.
              value={null}
              options={[...aliasOptions, ...savedOptions]}
              getOptionLabel={hopName}
              groupBy={
                savedOptions.length
                  ? (hop) => (isSavedHop(hop) ? 'Saved in Muxus' : 'From your SSH config')
                  : undefined
              }
              inputValue={pending}
              onInputChange={(_e, v) => setPending(v)}
              onChange={(_e, v) => {
                if (typeof v === 'string') add(v);
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Add jump host"
                  placeholder={
                    draft.storage === 'muxus'
                      ? 'Muxus host, alias from config, or user@host:port'
                      : 'alias from config, or user@host:port'
                  }
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
          <Typography variant="caption" color="textSecondary">
            {draft.storage === 'muxus'
              ? 'Each hop is authenticated and host-key verified with its own settings: a Muxus host with what it saved, any other hop through your SSH config.'
              : 'Each hop is authenticated and host-key verified using its own SSH config.'}
          </Typography>
        </Stack>
      ) : null}

      {draft.routeMode === 'command' ? (
        <TextField
          label="ProxyCommand"
          value={draft.proxyCommand}
          onChange={(e) => set({ proxyCommand: e.target.value })}
          placeholder="cloudflared access ssh --hostname %h"
          helperText="Supports OpenSSH tokens %% (percent), %h (host), %n (alias), %p (port), and %r (user)."
          fullWidth
        />
      ) : null}
    </Stack>
  );
}

function Labeled({ title, sub }: { title: string; sub: string }) {
  return (
    <Box sx={{ py: 0.25 }}>
      <Typography variant="body2">{title}</Typography>
      <Typography variant="caption" color="textSecondary">
        {sub}
      </Typography>
    </Box>
  );
}
