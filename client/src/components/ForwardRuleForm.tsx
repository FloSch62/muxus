import { useState } from 'react';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import AddIcon from '@mui/icons-material/Add';
import type { ConfigForward, ForwardType } from '@muxus/shared';
import { ForwardDiagram } from './ForwardDiagram.js';

/**
 * Tunnel-type toggle + live diagram + the three fields, shared between the
 * host editor (rules written to ssh config) and the runtime forwards dialog
 * (rules started on the live connection).
 */
export function ForwardRuleForm({
  serverLabel,
  onAdd,
  busy = false,
  submitLabel = 'Add',
}: {
  serverLabel: string;
  onAdd: (rule: ConfigForward) => void;
  busy?: boolean;
  submitLabel?: string;
}) {
  const [type, setType] = useState<ForwardType>('local');
  const [bindPort, setBindPort] = useState('');
  const [targetHost, setTargetHost] = useState('localhost');
  const [targetPort, setTargetPort] = useState('');

  const portOk = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536;
  const valid = portOk(bindPort) && (type === 'dynamic' || (!!targetHost.trim() && portOk(targetPort)));

  const submit = () => {
    if (!valid || busy) return;
    onAdd(
      type === 'dynamic'
        ? { type, bindPort: Number(bindPort) }
        : { type, bindPort: Number(bindPort), targetHost: targetHost.trim(), targetPort: Number(targetPort) },
    );
    setBindPort('');
    setTargetPort('');
  };

  return (
    <Stack spacing={2}>
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

      <ForwardDiagram type={type} bindPort={bindPort} targetHost={targetHost} targetPort={targetPort} serverLabel={serverLabel} />

      <Stack direction="row" spacing={1.5}>
        <TextField
          label={type === 'remote' ? 'Port on server' : 'Local port'}
          value={bindPort}
          onChange={(e) => setBindPort(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          sx={{ width: 140 }}
          autoComplete="off"
        />
        {type !== 'dynamic' && (
          <>
            <TextField label="Target host" value={targetHost} onChange={(e) => setTargetHost(e.target.value)} fullWidth />
            <TextField
              label="Target port"
              value={targetPort}
              onChange={(e) => setTargetPort(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              sx={{ width: 140 }}
              autoComplete="off"
            />
          </>
        )}
        <Button variant="outlined" startIcon={<AddIcon />} disabled={!valid || busy} onClick={submit} sx={{ flexShrink: 0, alignSelf: 'center' }}>
          {submitLabel}
        </Button>
      </Stack>
    </Stack>
  );
}

export function describeForward(f: Pick<ConfigForward, 'type' | 'bindPort' | 'targetHost' | 'targetPort'>): string {
  if (f.type === 'dynamic') return `SOCKS5 on 127.0.0.1:${f.bindPort}`;
  if (f.type === 'local') return `127.0.0.1:${f.bindPort} → ${f.targetHost}:${f.targetPort}`;
  return `remote :${f.bindPort} → ${f.targetHost}:${f.targetPort}`;
}

export const FORWARD_FLAG: Record<ForwardType, string> = { local: '-L', remote: '-R', dynamic: '-D' };
