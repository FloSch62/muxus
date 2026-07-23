import { useState } from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ForwardInfo, ForwardType } from '@muxus/shared';
import { apiFetch } from '../api/http.js';
import { useForwards } from '../api/queries.js';
import { showErrorToast } from '../state/toast.js';

function describe(f: ForwardInfo): string {
  if (f.type === 'dynamic') return `SOCKS5 on 127.0.0.1:${f.bindPort}`;
  if (f.type === 'local') return `127.0.0.1:${f.bindPort} → ${f.targetHost}:${f.targetPort}`;
  return `remote :${f.bindPort} → ${f.targetHost}:${f.targetPort}`;
}

/** Port forwarding manager for the active tab's SSH connection. */
export function ForwardsDialog({ connId, open, onClose }: { connId: string; open: boolean; onClose: () => void }) {
  const { data } = useForwards(open ? connId : undefined);
  const queryClient = useQueryClient();
  const [type, setType] = useState<ForwardType>('local');
  const [bindPort, setBindPort] = useState('');
  const [targetHost, setTargetHost] = useState('localhost');
  const [targetPort, setTargetPort] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['forwards', connId] });

  const create = useMutation({
    mutationFn: () =>
      apiFetch('/api/forwards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connId,
          type,
          bindPort: Number(bindPort),
          targetHost: type === 'dynamic' ? undefined : targetHost.trim(),
          targetPort: type === 'dynamic' ? undefined : Number(targetPort),
        }),
      }),
    onSuccess: () => {
      setBindPort('');
      setTargetPort('');
      invalidate();
    },
    onError: showErrorToast,
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/forwards/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: showErrorToast,
  });

  const portOk = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536;
  const valid = portOk(bindPort) && (type === 'dynamic' || (targetHost.trim() && portOk(targetPort)));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Port forwarding</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {(data?.forwards ?? []).map((f) => (
            <Stack key={f.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                label={f.type === 'local' ? '-L' : f.type === 'remote' ? '-R' : '-D'}
                color={f.status === 'error' ? 'error' : 'default'}
                sx={{ fontFamily: '"JetBrains Mono", monospace', width: 42 }}
              />
              <Typography variant="body2" sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>
                {describe(f)}
              </Typography>
              <Tooltip title="Stop forward">
                <IconButton size="small" aria-label="Stop forward" onClick={() => remove.mutate(f.id)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
          {!data?.forwards.length && (
            <Typography variant="body2" color="text.secondary">
              No active forwards on this connection.
            </Typography>
          )}
          <Divider />
          <Stack direction="row" spacing={1.5}>
            <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value as ForwardType)} sx={{ width: 150 }}>
              <MenuItem value="local">Local (-L)</MenuItem>
              <MenuItem value="remote">Remote (-R)</MenuItem>
              <MenuItem value="dynamic">SOCKS (-D)</MenuItem>
            </TextField>
            <TextField label={type === 'remote' ? 'Remote port' : 'Local port'} value={bindPort} onChange={(e) => setBindPort(e.target.value)} sx={{ width: 120 }} />
            {type !== 'dynamic' && (
              <>
                <TextField label="Target host" value={targetHost} onChange={(e) => setTargetHost(e.target.value)} fullWidth />
                <TextField label="Target port" value={targetPort} onChange={(e) => setTargetPort(e.target.value)} sx={{ width: 120 }} />
              </>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          Add forward
        </Button>
      </DialogActions>
    </Dialog>
  );
}
