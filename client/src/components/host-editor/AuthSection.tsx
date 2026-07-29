import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import type { SshKeysResponse } from '@muxus/shared';
import type { HostDraft, IdentityAgentMode, StrictHostKeyCheckingMode } from './draft.js';

/**
 * How to authenticate: OpenSSH default order (agent, then id_* keys), a
 * specific IdentityFile picked from the keys found in ~/.ssh, or password.
 * The picker badges keys that are loaded in the agent or passphrase-protected.
 */
export function AuthSection({
  draft,
  set,
  keys,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  keys: SshKeysResponse | undefined;
}) {
  const [pending, setPending] = useState('');
  const [pendingCertificate, setPendingCertificate] = useState('');
  const available = (keys?.keys ?? []).filter((k) => !draft.identityFiles.includes(k.path) && !draft.identityFiles.includes(`~/.ssh/${k.name}`));

  const addKey = (value: string) => {
    const v = value.trim();
    if (!v) return;
    set({ identityFiles: [...draft.identityFiles, v] });
    setPending('');
  };

  const keyMeta = (file: string) => keys?.keys.find((k) => k.path === file || `~/.ssh/${k.name}` === file || k.name === file.split(/[\\/]/).pop());
  const addCertificate = () => {
    const file = pendingCertificate.trim();
    if (!file || draft.certificateFiles.includes(file)) return;
    set({ certificateFiles: [...draft.certificateFiles, file] });
    setPendingCertificate('');
  };

  return (
    <Stack spacing={2}>
      <RadioGroup value={draft.authMode} onChange={(e) => set({ authMode: e.target.value as HostDraft['authMode'] })}>
        <FormControlLabel
          value="default"
          control={<Radio size="small" />}
          label={
            <Labeled title="Agent & default keys" sub="OpenSSH order: SSH agent first, then ~/.ssh/id_* files" />
          }
        />
        <FormControlLabel value="key" control={<Radio size="small" />} label={<Labeled title="Specific key file" sub="Writes IdentityFile — exactly these keys are offered" />} />
        <FormControlLabel
          value="password"
          control={<Radio size="small" />}
          label={<Labeled title="Password / interactive" sub="Skips public keys (PubkeyAuthentication no); you are prompted on connect" />}
        />
      </RadioGroup>

      {draft.authMode === 'key' && (
        <Stack spacing={1} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>
          {draft.identityFiles.map((file, i) => {
            const meta = keyMeta(file);
            return (
              <Stack key={`${file}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <KeyOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                <Typography sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflowWrap: 'anywhere' }}>{file}</Typography>
                {meta?.inAgent && (
                  <Tooltip title="Loaded in the SSH agent">
                    <Chip size="small" icon={<CheckCircleOutlinedIcon />} label="agent" color="success" variant="outlined" sx={{ height: 20 }} />
                  </Tooltip>
                )}
                {meta?.encrypted && (
                  <Tooltip title="Passphrase-protected — you may be prompted on connect">
                    <LockOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                  </Tooltip>
                )}
                <IconButton size="small" aria-label={`Remove ${file}`} onClick={() => set({ identityFiles: draft.identityFiles.filter((_, j) => j !== i) })}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}
          <Autocomplete
            freeSolo
            options={available}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.path)}
            inputValue={pending}
            onInputChange={(_e, v) => setPending(v)}
            onChange={(_e, v) => {
              if (v) addKey(typeof v === 'string' ? v : v.path);
            }}
            renderOption={(props, o) => (
              <Box component="li" {...props} key={o.path}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
                  <KeyOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2">{o.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {[o.type, o.comment].filter(Boolean).join(' · ') || o.path}
                    </Typography>
                  </Box>
                  {o.inAgent && <Chip size="small" label="agent" color="success" variant="outlined" sx={{ height: 18 }} />}
                  {o.encrypted && <LockOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />}
                </Stack>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Add key"
                placeholder="pick from ~/.ssh or type a path"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pending.trim()) {
                    e.preventDefault();
                    addKey(pending);
                  }
                }}
              />
            )}
          />
          {window.muxusDesktop && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                Key stored elsewhere?
              </Typography>
              <Button
                variant="outlined"
                startIcon={<FolderOpenOutlinedIcon />}
                onClick={() => {
                  void window.muxusDesktop?.selectPrivateKey().then((path) => {
                    if (path) addKey(path);
                  });
                }}
              >
                Browse files…
              </Button>
            </Stack>
          )}
          <Stack spacing={1} sx={{ pt: 1 }}>
            <Box>
              <Typography variant="body2">User certificates</Typography>
              <Typography variant="caption" color="text.secondary">
                Writes CertificateFile. Each certificate is matched to its private key above.
              </Typography>
            </Box>
            {draft.certificateFiles.map((file, i) => (
              <Stack key={`${file}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <VerifiedUserOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                <Typography sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflowWrap: 'anywhere' }}>
                  {file}
                </Typography>
                <IconButton
                  size="small"
                  aria-label={`Remove certificate ${file}`}
                  onClick={() => set({ certificateFiles: draft.certificateFiles.filter((_, j) => j !== i) })}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField
                fullWidth
                label="Add certificate"
                placeholder="~/.ssh/id_ed25519-cert.pub"
                value={pendingCertificate}
                onChange={(e) => setPendingCertificate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCertificate();
                  }
                }}
              />
              <IconButton
                aria-label="Add certificate"
                disabled={!pendingCertificate.trim()}
                onClick={addCertificate}
                sx={{ mt: 0.5 }}
              >
                <AddIcon />
              </IconButton>
            </Stack>
          </Stack>
          <FormControlLabel
            control={<Switch size="small" checked={draft.identitiesOnly} onChange={(e) => set({ identitiesOnly: e.target.checked })} />}
            label={<Labeled title="IdentitiesOnly" sub="Never offer other agent keys — avoids 'too many authentication failures'" />}
          />
        </Stack>
      )}

      <Divider />

      <Stack spacing={1.5}>
        <Box>
          <Typography variant="subtitle2">SSH agent</Typography>
          <Typography variant="caption" color="text.secondary">
            Choose which local agent supplies keys for this host.
          </Typography>
        </Box>
        <TextField
          select
          label="Agent source"
          value={draft.identityAgentMode}
          onChange={(e) => {
            const identityAgentMode = e.target.value as IdentityAgentMode;
            set({
              identityAgentMode,
              ...(identityAgentMode === 'none' ? { forwardAgent: false } : {}),
            });
          }}
          helperText={agentSourceHelp(draft.identityAgentMode)}
          fullWidth
        >
          <MenuItem value="default">Use SSH configuration</MenuItem>
          <MenuItem value="environment">SSH_AUTH_SOCK environment agent</MenuItem>
          <MenuItem value="custom">Custom socket or environment variable</MenuItem>
          <MenuItem value="none">Do not use an agent</MenuItem>
        </TextField>
        {draft.identityAgentMode === 'custom' ? (
          <TextField
            label="Agent socket"
            value={draft.identityAgent}
            onChange={(e) => set({ identityAgent: e.target.value })}
            placeholder="~/.1password/agent.sock or ${CUSTOM_SOCK}"
            helperText="Accepts a socket path, $VAR, or ${VAR}."
            fullWidth
          />
        ) : null}
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={draft.forwardAgent}
              disabled={draft.identityAgentMode === 'none'}
              onChange={(e) => set({ forwardAgent: e.target.checked })}
            />
          }
          label={<Labeled title="Forward agent" sub="Lets the remote host use your selected local SSH agent" />}
        />

        <Typography variant="caption" color="text.secondary">
          {keys
            ? keys.agentAvailable
              ? `Agent detected — ${keys.agentKeys.length} key${keys.agentKeys.length === 1 ? '' : 's'} loaded.`
              : 'No agent detected in SSH_AUTH_SOCK. A custom agent may still be available.'
            : ''}
        </Typography>
      </Stack>

      <Divider />

      <Stack spacing={1.5}>
        <Box>
          <Typography variant="subtitle2">Host-key security</Typography>
          <Typography variant="caption" color="text.secondary">
            Control what happens when a server has not been seen before.
          </Typography>
        </Box>
        <TextField
          select
          label="Host verification"
          value={draft.strictHostKeyChecking}
          onChange={(e) =>
            set({
              strictHostKeyChecking: e.target.value as StrictHostKeyCheckingMode,
            })
          }
          helperText={hostVerificationHelp(draft.strictHostKeyChecking)}
          fullWidth
        >
          <MenuItem value="inherit">Use SSH configuration</MenuItem>
          <MenuItem value="ask">Ask before trusting a new host</MenuItem>
          <MenuItem value="accept-new">Trust new hosts automatically</MenuItem>
          <MenuItem value="yes">Require a saved host key</MenuItem>
          <MenuItem value="no">Disable strict checking (no)</MenuItem>
        </TextField>
      </Stack>
    </Stack>
  );
}

function hostVerificationHelp(value: StrictHostKeyCheckingMode): string {
  switch (value) {
    case 'yes':
      return 'Refuses hosts whose key is not already saved.';
    case 'accept-new':
      return 'Saves first-contact keys silently, but still warns if a saved key changes.';
    case 'no':
      return 'Accepts first-contact keys. Muxus still warns if a saved key changes.';
    case 'ask':
      return 'Prompts before saving a first-contact key and whenever a saved key changes.';
    default:
      return 'Inherits StrictHostKeyChecking; the normal default is to ask.';
  }
}

function agentSourceHelp(mode: IdentityAgentMode): string {
  switch (mode) {
    case 'environment':
      return 'Overrides inherited agent settings and reads SSH_AUTH_SOCK when connecting.';
    case 'custom':
      return 'Use a 1Password, Secretive, or other agent socket for this host.';
    case 'none':
      return 'Disables agent authentication and agent forwarding for this host.';
    default:
      return 'Inherits the normal SSH configuration and environment.';
  }
}

function Labeled({ title, sub }: { title: string; sub: string }) {
  return (
    <Box sx={{ py: 0.25 }}>
      <Typography variant="body2">{title}</Typography>
      <Typography variant="caption" color="text.secondary">
        {sub}
      </Typography>
    </Box>
  );
}
