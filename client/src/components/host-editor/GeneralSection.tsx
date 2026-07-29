import { useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SshConfigResponse } from '@muxus/shared';
import { FolderPathField } from '../FolderPathField.js';
import { HostColorPicker } from '../HostColorPicker.js';
import type { HostDraft, RemoteCommandMode, RequestTtyMode } from './draft.js';
import { draftAliases } from './draft.js';

const NEW_FILE = '__new__';

export function shortenPath(p: string): string {
  return p.replace(/^.*([\\/]\.ssh[\\/])/, '~/.ssh/');
}

/**
 * Alias, target address, description, which config file the block lives in,
 * and the Muxus-only presentation metadata. The Telnet/serial editor offers
 * the same metadata in the same place, so organizing a host never depends on
 * which kind it is.
 */
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
        placeholder="shown in the host list"
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

      <Divider />
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="subtitle2">Startup behavior</Typography>
          <Typography variant="caption" color="text.secondary">
            Choose what opens after authentication and whether the server should allocate a terminal.
          </Typography>
        </Box>
        <TextField
          select
          label="After connecting"
          value={draft.remoteCommandMode}
          onChange={(e) => set({ remoteCommandMode: e.target.value as RemoteCommandMode })}
          helperText={remoteCommandHelp(draft.remoteCommandMode)}
          fullWidth
        >
          <MenuItem value="inherit">Use SSH configuration</MenuItem>
          <MenuItem value="shell">Open a login shell</MenuItem>
          <MenuItem value="command">Run a startup command</MenuItem>
        </TextField>
        {draft.remoteCommandMode === 'command' ? (
          <TextField
            label="Startup command"
            value={draft.remoteCommand}
            onChange={(e) => set({ remoteCommand: e.target.value })}
            placeholder="tmux new -A -s main"
            helperText="Runs on the remote host instead of its login shell."
            fullWidth
          />
        ) : null}
        <TextField
          select
          label="Terminal allocation (TTY)"
          value={draft.requestTty}
          onChange={(e) => set({ requestTty: e.target.value as RequestTtyMode })}
          helperText={requestTtyHelp(draft.requestTty, draft.remoteCommandMode)}
          fullWidth
        >
          <MenuItem value="inherit">Use SSH configuration</MenuItem>
          <MenuItem value="auto">Automatic</MenuItem>
          <MenuItem value="yes">Always allocate a terminal</MenuItem>
          <MenuItem value="no">Do not allocate a terminal</MenuItem>
          <MenuItem value="force">Force terminal allocation</MenuItem>
        </TextField>
      </Stack>

      <Divider />
      <Typography variant="caption" color="text.secondary">
        Display name, group and color are local to Muxus — they never touch your
        ssh config.
      </Typography>
      <TextField
        label="Display name"
        value={draft.displayName}
        onChange={(e) => set({ displayName: e.target.value })}
        placeholder={primary ?? 'the alias'}
        helperText="Optional — only changes how this host appears in Muxus."
        fullWidth
      />
      <FolderPathField
        value={draft.group}
        onChange={(group: string) => set({ group })}
        helperText="Optional — use / to nest, e.g. Production/EU."
      />
      <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
    </Stack>
  );
}

function remoteCommandHelp(mode: RemoteCommandMode): string {
  switch (mode) {
    case 'shell':
      return 'Explicitly disables an inherited RemoteCommand and opens the normal shell.';
    case 'command':
      return 'Runs one command after authentication instead of opening the normal shell.';
    default:
      return 'Uses any RemoteCommand inherited from matching SSH configuration.';
  }
}

function requestTtyHelp(value: RequestTtyMode, commandMode: RemoteCommandMode): string {
  switch (value) {
    case 'auto':
      return commandMode === 'command'
        ? 'A startup command runs without a terminal; choose “Always” for interactive tools such as tmux.'
        : 'Allocates a terminal for a login shell.';
    case 'yes':
      return 'Allocates a terminal for both login shells and startup commands.';
    case 'force':
      return 'Forces a terminal even when the local session is not interactive.';
    case 'no':
      return 'Runs without a terminal.';
    default:
      return commandMode === 'command'
        ? 'Inherits RequestTTY; SSH normally runs startup commands without a terminal.'
        : 'Inherits RequestTTY; SSH normally allocates a terminal for a login shell.';
  }
}
