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
  canChooseStorage = false,
}: {
  draft: HostDraft;
  set: (patch: Partial<HostDraft>) => void;
  config: SshConfigResponse | undefined;
  canChooseStorage?: boolean;
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
  const configBacked = draft.storage === 'openssh';

  return (
    <Stack spacing={2}>
      {canChooseStorage ? (
        <TextField
          select
          label="Save host in"
          value={draft.storage}
          onChange={(event) =>
            set({ storage: event.target.value as HostDraft['storage'] })
          }
          helperText={
            configBacked
              ? 'Writes a standard Host block that also works with ssh in any terminal.'
              : 'Keeps this connection in the Muxus database and does not change ssh_config.'
          }
          fullWidth
        >
          <MenuItem value="muxus">Muxus app data only</MenuItem>
          <MenuItem value="openssh">OpenSSH config</MenuItem>
        </TextField>
      ) : null}
      <Stack direction="row" spacing={1.5}>
        <TextField
          label={configBacked ? 'Alias' : 'Name'}
          value={draft.aliasText}
          onChange={(e) => set({ aliasText: e.target.value })}
          required
          fullWidth
          helperText={
            configBacked
              ? primary
                ? `Connect with: ssh ${primary}`
                : 'The name you connect as — also works in any terminal'
              : 'How this host appears in Muxus'
          }
        />
      </Stack>
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="HostName"
          value={draft.hostname}
          onChange={(e) => set({ hostname: e.target.value })}
          placeholder={configBacked ? 'defaults to the alias' : 'router.example.com'}
          required={!configBacked}
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
      {configBacked ? (
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
      ) : null}
      {configBacked ? (
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
          {selectValue === NEW_FILE ? (
            <>
              <TextField
                label="Group name"
                value={newFileName}
                onChange={(e) => applyNewFile(e.target.value)}
                placeholder="work"
                fullWidth
              />
              <Typography variant="caption" color="text.secondary">
                Creates {shortenPath(draft.file || `${sshDir}config.d/…`)} and adds
                an Include to your config — the sidebar groups hosts by file.
              </Typography>
            </>
          ) : null}
        </Stack>
      ) : null}

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
          helperText={remoteCommandHelp(draft.remoteCommandMode, configBacked)}
          fullWidth
        >
          <MenuItem value="inherit">
            {configBacked ? 'Use SSH configuration' : 'Open a login shell'}
          </MenuItem>
          {configBacked ? <MenuItem value="shell">Open a login shell</MenuItem> : null}
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
          helperText={requestTtyHelp(
            draft.requestTty,
            draft.remoteCommandMode,
            configBacked,
          )}
          fullWidth
        >
          <MenuItem value="inherit">
            {configBacked ? 'Use SSH configuration' : 'Automatic'}
          </MenuItem>
          {configBacked ? <MenuItem value="auto">Automatic</MenuItem> : null}
          <MenuItem value="yes">Always allocate a terminal</MenuItem>
          <MenuItem value="no">Do not allocate a terminal</MenuItem>
          <MenuItem value="force">Force terminal allocation</MenuItem>
        </TextField>
      </Stack>

      <Divider />
      <Typography variant="caption" color="text.secondary">
        {configBacked
          ? 'Display name, group and color are local to Muxus — they never touch your ssh config.'
          : 'Group and color are stored with this connection in Muxus app data.'}
      </Typography>
      {configBacked ? (
        <TextField
          label="Display name"
          value={draft.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
          placeholder={primary ?? 'the alias'}
          helperText="Optional — only changes how this host appears in Muxus."
          fullWidth
        />
      ) : null}
      <FolderPathField
        value={draft.group}
        onChange={(group: string) => set({ group })}
        helperText="Optional — use / to nest, e.g. Production/EU."
      />
      <HostColorPicker value={draft.color} onChange={(color) => set({ color })} />
    </Stack>
  );
}

function remoteCommandHelp(mode: RemoteCommandMode, configBacked: boolean): string {
  switch (mode) {
    case 'shell':
      return 'Explicitly disables an inherited RemoteCommand and opens the normal shell.';
    case 'command':
      return 'Runs one command after authentication instead of opening the normal shell.';
    default:
      return configBacked
        ? 'Uses any RemoteCommand inherited from matching SSH configuration.'
        : 'Opens the server’s default login shell.';
  }
}

function requestTtyHelp(
  value: RequestTtyMode,
  commandMode: RemoteCommandMode,
  configBacked: boolean,
): string {
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
      if (!configBacked) {
        return commandMode === 'command'
          ? 'Runs startup commands without a terminal unless you choose another setting.'
          : 'Allocates a terminal for a login shell.';
      }
      return commandMode === 'command'
        ? 'Inherits RequestTTY; SSH normally runs startup commands without a terminal.'
        : 'Inherits RequestTTY; SSH normally allocates a terminal for a login shell.';
  }
}
