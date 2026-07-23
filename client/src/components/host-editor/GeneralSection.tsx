import { useState } from 'react';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SshConfigResponse } from '@muxus/shared';
import type { HostDraft } from './draft.js';
import { draftAliases } from './draft.js';

const NEW_FILE = '__new__';

export function shortenPath(p: string): string {
  return p.replace(/^.*([\\/]\.ssh[\\/])/, '~/.ssh/');
}

/** Alias, target address, description and which config file the block lives in. */
export function GeneralSection({
  draft,
  set,
  config,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  config: SshConfigResponse | undefined;
}) {
  const [newFileName, setNewFileName] = useState('');
  const rootPath = config?.path ?? '~/.ssh/config';
  const files = config?.files ?? [];
  const knownFile = !draft.file || files.includes(draft.file);
  const selectValue = !draft.file ? rootPath : knownFile ? draft.file : NEW_FILE;

  const sshDir = rootPath.replace(/[^\\/]+$/, '');
  const applyNewFile = (name: string) => {
    setNewFileName(name);
    const clean = name.trim().replace(/[^A-Za-z0-9._-]/g, '');
    if (clean) set({ file: `${sshDir}config.d/${clean}` });
  };

  const primary = draftAliases(draft)[0];

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="Alias"
          value={draft.aliasText}
          onChange={(e) => set({ aliasText: e.target.value })}
          required
          fullWidth
          helperText={primary ? `Connect with: ssh ${primary}` : 'The name you connect as — also works in any terminal'}
        />
      </Stack>
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="HostName"
          value={draft.hostname}
          onChange={(e) => set({ hostname: e.target.value })}
          placeholder="defaults to the alias"
          fullWidth
        />
        <TextField
          label="Port"
          value={draft.port}
          onChange={(e) => set({ port: e.target.value.replace(/[^\d]/g, '') })}
          placeholder="22"
          sx={{ width: 120 }}
        />
      </Stack>
      <TextField label="User" value={draft.user} onChange={(e) => set({ user: e.target.value })} placeholder="current user" fullWidth />
      <TextField
        label="Description"
        value={draft.description}
        onChange={(e) => set({ description: e.target.value })}
        placeholder="shown in the session list"
        helperText="Stored as a # comment above the Host block"
        fullWidth
        multiline
        maxRows={3}
      />
      <Stack spacing={1}>
        <TextField
          select
          label="Config file"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW_FILE) applyNewFile(newFileName || 'group');
            else set({ file: v === rootPath ? '' : v });
          }}
          fullWidth
        >
          {[rootPath, ...files.filter((f) => f !== rootPath)].map((f) => (
            <MenuItem key={f} value={f === rootPath ? rootPath : f}>
              {shortenPath(f)}
            </MenuItem>
          ))}
          <MenuItem value={NEW_FILE}>New group file…</MenuItem>
        </TextField>
        {selectValue === NEW_FILE && (
          <>
            <TextField
              label="Group name"
              value={newFileName}
              onChange={(e) => applyNewFile(e.target.value)}
              placeholder="work"
              fullWidth
            />
            <Typography variant="caption" color="text.secondary">
              Creates {shortenPath(draft.file || `${sshDir}config.d/…`)} and adds an Include to your config — the sidebar groups hosts by
              file.
            </Typography>
          </>
        )}
      </Stack>
    </Stack>
  );
}
