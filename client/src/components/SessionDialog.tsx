import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { openSavedSession } from '../session-actions.js';
import { newSessionId, useSessionsStore, type SavedSession } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';

const blank = (): SavedSession => ({ id: newSessionId(), name: '', host: '', auth: 'agent' });

/** Create/edit a saved SSH session; "Save & connect" opens a tab right away. */
export function SessionDialog() {
  const value = useUiStore((s) => s.sessionDialog);
  const setValue = useUiStore((s) => s.setSessionDialog);
  const save = useSessionsStore((s) => s.save);
  const [draft, setDraft] = useState<SavedSession>(blank);

  useEffect(() => {
    if (value === 'new') setDraft(blank());
    else if (value) setDraft({ ...value });
  }, [value]);

  if (!value) return null;
  const editing = value !== 'new';
  const valid = draft.host.trim().length > 0 && (draft.auth !== 'key' || !!draft.keyPath?.trim());

  const normalize = (): SavedSession => ({
    ...draft,
    name: draft.name.trim() || `${draft.user ? `${draft.user}@` : ''}${draft.host.trim()}`,
    host: draft.host.trim(),
    user: draft.user?.trim() || undefined,
    keyPath: draft.auth === 'key' ? draft.keyPath?.trim() : undefined,
    group: draft.group?.trim() || undefined,
  });

  const submit = (connect: boolean) => {
    const session = normalize();
    save(session);
    setValue(false);
    if (connect) openSavedSession(session);
  };

  const set = (patch: Partial<SavedSession>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Dialog open onClose={() => setValue(false)} maxWidth="xs" fullWidth>
      <DialogTitle>{editing ? 'Edit session' : 'New SSH session'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1.5}>
            <TextField label="Host" value={draft.host} onChange={(e) => set({ host: e.target.value })} autoFocus fullWidth required />
            <TextField
              label="Port"
              value={draft.port ?? ''}
              onChange={(e) => {
                const port = Number(e.target.value);
                set({ port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined });
              }}
              sx={{ width: 110 }}
              placeholder="22"
            />
          </Stack>
          <TextField label="User" value={draft.user ?? ''} onChange={(e) => set({ user: e.target.value })} placeholder="current user" fullWidth />
          <TextField select label="Authentication" value={draft.auth} onChange={(e) => set({ auth: e.target.value as SavedSession['auth'] })} fullWidth>
            <MenuItem value="agent">SSH agent</MenuItem>
            <MenuItem value="key">Private key file</MenuItem>
            <MenuItem value="password">Password</MenuItem>
          </TextField>
          {draft.auth === 'key' && (
            <TextField label="Key file" value={draft.keyPath ?? ''} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" fullWidth required />
          )}
          <TextField label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="defaults to user@host" fullWidth />
          <TextField label="Group" value={draft.group ?? ''} onChange={(e) => set({ group: e.target.value })} placeholder="optional sidebar group" fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setValue(false)}>Cancel</Button>
        <Button disabled={!valid} onClick={() => submit(false)}>
          Save
        </Button>
        <Button variant="contained" disabled={!valid} onClick={() => submit(true)}>
          Save & connect
        </Button>
      </DialogActions>
    </Dialog>
  );
}
