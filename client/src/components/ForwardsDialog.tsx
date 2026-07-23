import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigForward, ForwardInfo } from '@muxus/shared';
import { apiFetch } from '../api/http.js';
import { useForwards, useSshConfig } from '../api/queries.js';
import { useUpsertHost } from '../api/ssh-config.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { FORWARD_FLAG, ForwardRuleForm, describeForward } from './ForwardRuleForm.js';

/**
 * Port forwarding on the active tab's live connection. Config-declared
 * forwards appear with a "config" chip (they started with the session);
 * ad-hoc ones can be bookmarked into the Host block so they come back
 * on the next connect.
 */
export function ForwardsDialog({ connId, target, open, onClose }: { connId: string; target?: string; open: boolean; onClose: () => void }) {
  const { data } = useForwards(open ? connId : undefined);
  const { data: config } = useSshConfig();
  const queryClient = useQueryClient();
  const hostEntry = target ? config?.hosts.find((h) => h.aliases.includes(target)) : undefined;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['forwards', connId] });

  const create = useMutation({
    mutationFn: (rule: ConfigForward) =>
      apiFetch('/api/forwards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connId, ...rule }),
      }),
    onSuccess: invalidate,
    onError: showErrorToast,
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/forwards/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: showErrorToast,
  });

  const saveToConfig = useUpsertHost(() => showToast('success', `Saved to ${hostEntry?.alias} — starts with every connection.`));

  const alreadyInConfig = (f: ForwardInfo): boolean =>
    !!hostEntry?.options.forwards?.some(
      (c) => c.type === f.type && c.bindPort === f.bindPort && c.targetHost === f.targetHost && c.targetPort === f.targetPort,
    );

  const bookmark = (f: ForwardInfo) => {
    if (!hostEntry) return;
    const rule: ConfigForward =
      f.type === 'dynamic' ? { type: f.type, bindPort: f.bindPort } : { type: f.type, bindPort: f.bindPort, targetHost: f.targetHost, targetPort: f.targetPort };
    saveToConfig.mutate({
      aliases: hostEntry.aliases,
      description: hostEntry.description,
      file: hostEntry.file,
      previousAlias: hostEntry.alias,
      options: { ...hostEntry.options, forwards: [...(hostEntry.options.forwards ?? []), rule] },
    });
  };

  const forwards = data?.forwards ?? [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        Port forwarding
        {target && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            on {target}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {forwards.map((f) => (
            <Stack key={f.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                label={FORWARD_FLAG[f.type]}
                color={f.status === 'error' ? 'error' : 'default'}
                sx={{ fontFamily: '"JetBrains Mono", monospace', width: 44 }}
              />
              <Typography variant="body2" sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>
                {describeForward(f)}
                {f.error ? ` — ${f.error}` : ''}
              </Typography>
              {f.origin === 'config' ? (
                <Tooltip title="Declared in ssh config — started with the session">
                  <Chip size="small" label="config" variant="outlined" sx={{ height: 20 }} />
                </Tooltip>
              ) : (
                hostEntry && (
                  <Tooltip title={alreadyInConfig(f) ? 'Already in the Host block' : `Save to ${hostEntry.alias}'s config — starts on every connect`}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label="Save forward to config"
                        disabled={alreadyInConfig(f) || saveToConfig.isPending}
                        onClick={() => bookmark(f)}
                      >
                        <BookmarkAddOutlinedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )
              )}
              <Tooltip title={f.origin === 'config' ? 'Stop for this session (the config rule stays)' : 'Stop forward'}>
                <IconButton size="small" aria-label="Stop forward" onClick={() => remove.mutate(f.id)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
          {forwards.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No active forwards on this connection.
            </Typography>
          )}
          <Divider />
          <ForwardRuleForm serverLabel={target ?? 'SSH server'} busy={create.isPending} onAdd={(rule) => create.mutate(rule)} submitLabel="Start" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
