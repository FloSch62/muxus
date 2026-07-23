import { useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useMutation } from '@tanstack/react-query';
import type { ForwardType, TunnelRecord } from '@muxus/shared';
import { saveTunnel } from '../api/tunnels.js';
import { useSshConfig } from '../api/queries.js';
import { showErrorToast } from '../state/toast.js';
import { ForwardDiagram } from './ForwardDiagram.js';

export interface TunnelEditorState {
  /** Present when editing an existing tunnel. */
  tunnel?: TunnelRecord;
  /** Preselected SSH target for new tunnels. */
  prefillTarget?: string;
}

/** Create/edit a saved tunnel: a forwarding rule bound to an SSH target. */
export function TunnelEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state: TunnelEditorState | null;
  onClose: () => void;
  onSaved: (record: TunnelRecord, start: boolean) => void;
}) {
  return (
    <Dialog open={!!state} onClose={onClose} maxWidth="sm" fullWidth>
      {state && <TunnelEditorForm state={state} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function TunnelEditorForm({
  state,
  onClose,
  onSaved,
}: {
  state: TunnelEditorState;
  onClose: () => void;
  onSaved: (record: TunnelRecord, start: boolean) => void;
}) {
  const { data: config } = useSshConfig();
  const editing = state.tunnel;
  const [name, setName] = useState(editing?.name ?? '');
  const [target, setTarget] = useState(editing?.target ?? state.prefillTarget ?? '');
  const [type, setType] = useState<ForwardType>(editing?.type ?? 'local');
  const [bindPort, setBindPort] = useState(editing ? String(editing.bindPort) : '');
  const [targetHost, setTargetHost] = useState(editing?.targetHost ?? 'localhost');
  const [targetPort, setTargetPort] = useState(editing?.targetPort ? String(editing.targetPort) : '');

  const aliases = (config?.hosts ?? []).flatMap((host) => host.aliases);
  const portOk = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536;
  const valid = !!target.trim() && portOk(bindPort) && (type === 'dynamic' || (!!targetHost.trim() && portOk(targetPort)));

  const save = useMutation({
    mutationFn: (start: boolean) =>
      saveTunnel({
        id: editing?.id,
        name: name.trim() || undefined,
        target: target.trim(),
        type,
        bindPort: Number(bindPort),
        targetHost: type === 'dynamic' ? undefined : targetHost.trim(),
        targetPort: type === 'dynamic' ? undefined : Number(targetPort),
      }).then((record) => ({ record, start })),
    onSuccess: ({ record, start }) => {
      onClose();
      onSaved(record, start);
    },
    onError: showErrorToast,
  });

  return (
    <>
      <DialogTitle>{editing ? 'Edit tunnel' : 'New tunnel'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1.5}>
            <TextField
              label="Name"
              placeholder="Optional label"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
            />
            <Autocomplete
              freeSolo
              fullWidth
              options={aliases}
              inputValue={target}
              onInputChange={(_e, value) => setTarget(value)}
              renderInput={(params) => (
                <TextField {...params} label="SSH host" placeholder="alias or user@host[:port]" />
              )}
            />
          </Stack>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={type}
            onChange={(_e, v: ForwardType | null) => {
              if (v) setType(v);
            }}
          >
            <ToggleButton value="local">Local (-L)</ToggleButton>
            <ToggleButton value="remote">Remote (-R)</ToggleButton>
            <ToggleButton value="dynamic">SOCKS proxy (-D)</ToggleButton>
          </ToggleButtonGroup>
          <ForwardDiagram
            type={type}
            bindPort={bindPort}
            targetHost={targetHost}
            targetPort={targetPort}
            serverLabel={target.trim() || 'SSH server'}
          />
          <Stack direction="row" spacing={1.5}>
            <TextField
              label={type === 'remote' ? 'Port on server' : 'Local port'}
              value={bindPort}
              onChange={(e) => setBindPort(e.target.value.replace(/[^\d]/g, ''))}
              sx={{ width: 160 }}
              autoComplete="off"
            />
            {type !== 'dynamic' && (
              <>
                <TextField label="Target host" value={targetHost} onChange={(e) => setTargetHost(e.target.value)} fullWidth />
                <TextField
                  label="Target port"
                  value={targetPort}
                  onChange={(e) => setTargetPort(e.target.value.replace(/[^\d]/g, ''))}
                  sx={{ width: 160 }}
                  autoComplete="off"
                />
              </>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!valid || save.isPending} onClick={() => save.mutate(false)}>
          Save
        </Button>
        <Button variant="contained" disabled={!valid || save.isPending} onClick={() => save.mutate(true)}>
          {editing ? 'Save & restart' : 'Save & start'}
        </Button>
      </DialogActions>
    </>
  );
}
