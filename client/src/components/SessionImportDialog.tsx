import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import {
  restoreImportedConnections,
  type PortableConnections,
  type TransferConflictStrategy,
} from '../data-transfer.js';
import type {
  ImportedSession,
  ImportedSessionParseResult,
} from '../session-import.js';
import { errorDetails, showToast } from '../state/toast.js';

export interface SessionImportSource {
  source: string;
  content: string;
}

interface PendingImport<T extends ImportedSession> {
  source: string;
  parsed: ImportedSessionParseResult<T>;
}

interface AutoImportSource {
  icon: React.ReactNode;
  title: string;
  description: string;
  load: () => Promise<SessionImportSource | undefined>;
}

export function SessionImportDialog<T extends ImportedSession>({
  onClose,
  vendorName,
  icon,
  idleSubtitle,
  sourceIntro,
  fileDescription,
  fileAccept,
  maxBytes,
  reviewNotice,
  privacyNotice,
  parse,
  connections,
  autoSource,
}: {
  onClose: () => void;
  vendorName: string;
  icon: React.ReactNode;
  idleSubtitle: string;
  sourceIntro: string;
  fileDescription: string;
  fileAccept: string;
  maxBytes: number;
  reviewNotice: string;
  privacyNotice: string;
  parse: (content: string) => ImportedSessionParseResult<T>;
  connections: (sessions: readonly T[]) => PortableConnections;
  autoSource?: AutoImportSource;
}) {
  const queryClient = useQueryClient();
  const { data: sshConfig } = useSshConfig();
  const { data: savedProfiles } = useSavedHostProfiles();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImport<T> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [conflicts, setConflicts] = useState<TransferConflictStrategy>('keep');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'detect' | 'file' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existingAliases = useMemo(
    () => new Set(sshConfig?.hosts.flatMap((host) => host.aliases) ?? []),
    [sshConfig?.hosts],
  );
  const existingProfileIds = useMemo(
    () => new Set(savedProfiles?.profiles.map((profile) => profile.id) ?? []),
    [savedProfiles?.profiles],
  );
  const isConflict = useCallback(
    (session: ImportedSession) =>
      session.kind === 'ssh'
        ? existingAliases.has(session.alias)
        : existingProfileIds.has(session.profileId),
    [existingAliases, existingProfileIds],
  );
  const conflictingSessions = useMemo(
    () => pending?.parsed.sessions.filter(isConflict) ?? [],
    [isConflict, pending?.parsed.sessions],
  );
  const filteredSessions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!pending || !needle) return pending?.parsed.sessions ?? [];
    return pending.parsed.sessions.filter((session) =>
      searchableSessionValues(session).some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [pending, search]);

  const review = (content: string, source: string) => {
    const parsed = parse(content);
    setPending({ source, parsed });
    setSelected(new Set(parsed.sessions.map((session) => session.id)));
    setSearch('');
    setError(null);
  };

  const detectLocal = async () => {
    if (!autoSource) return;
    setBusy('detect');
    setError(null);
    try {
      const source = await autoSource.load();
      if (source) review(source.content, source.source);
    } catch (detectError) {
      setError(messageFrom(detectError, `Could not read local ${vendorName} sessions.`));
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file: File) => {
    if (file.size > maxBytes) {
      setError(`That ${vendorName} file is larger than ${formatMegabytes(maxBytes)} MB.`);
      return;
    }
    setBusy('file');
    setError(null);
    try {
      review(await file.text(), file.name);
    } catch (fileError) {
      setError(messageFrom(fileError, `Could not read that ${vendorName} file.`));
    } finally {
      setBusy(null);
    }
  };

  const toggleSession = (session: T) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
  };

  const importSessions = async () => {
    if (!pending) return;
    const included = pending.parsed.sessions.filter((session) => selected.has(session.id));
    if (included.length === 0) return;
    setBusy('import');
    setError(null);
    try {
      const result = await restoreImportedConnections(connections(included), conflicts);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ssh-config'] }),
        queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['data-transfer-summary'] }),
      ]);
      const summary = [
        result.added ? `${result.added} added` : '',
        result.updated ? `${result.updated} replaced` : '',
        result.skipped ? `${result.skipped} kept` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      showToast('success', `${vendorName} import complete${summary ? ` — ${summary}` : ''}.`);
      onClose();
    } catch (importError) {
      const message = messageFrom(
        importError,
        `The ${vendorName} sessions could not be imported.`,
      );
      setError(message);
      showToast('error', message, errorDetails(importError));
    } finally {
      setBusy(null);
    }
  };

  const selectedCount = selected.size;
  const close = busy ? undefined : onClose;

  return (
    <Dialog open onClose={close} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
          {pending ? (
            <Button
              size="small"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => {
                setPending(null);
                setError(null);
              }}
              disabled={busy !== null}
            >
              Back
            </Button>
          ) : (
            icon
          )}
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Import from {vendorName}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {pending
                ? `${pending.parsed.sessions.length} supported sessions from ${pending.source}`
                : idleSubtitle}
            </Typography>
          </Box>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {pending ? (
          <Stack spacing={2}>
            <Alert severity="info">{reviewNotice}</Alert>
            {pending.parsed.ignoredCount > 0 ? (
              <Alert severity="warning">
                {pending.parsed.ignoredCount} unsupported or incomplete{' '}
                {pending.parsed.ignoredCount === 1 ? 'session was' : 'sessions were'} skipped.
              </Alert>
            ) : null}

            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <TextField
                size="small"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter sessions"
                sx={{ flex: 1 }}
                slotProps={{
                  input: {
                    startAdornment: (
                      <SearchOutlinedIcon sx={{ mr: 1, fontSize: 19, color: 'text.secondary' }} />
                    ),
                  },
                }}
              />
              <Button
                size="small"
                onClick={() =>
                  setSelected(
                    selected.size === pending.parsed.sessions.length
                      ? new Set()
                      : new Set(pending.parsed.sessions.map((session) => session.id)),
                  )
                }
              >
                {selected.size === pending.parsed.sessions.length
                  ? 'Clear selection'
                  : 'Select all'}
              </Button>
            </Stack>

            <Paper variant="outlined" sx={{ maxHeight: 330, overflowY: 'auto' }}>
              <List disablePadding>
                {filteredSessions.map((session, index) => {
                  const conflict = isConflict(session);
                  return (
                    <Box key={session.id}>
                      {index > 0 ? <Divider /> : null}
                      <ListItem
                        secondaryAction={
                          conflict ? <Chip size="small" color="warning" label="Already exists" /> : null
                        }
                        sx={{
                          pr: conflict ? 16 : 2,
                          contentVisibility: 'auto',
                          containIntrinsicSize: '56px',
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 38 }}>
                          <Checkbox
                            edge="start"
                            checked={selected.has(session.id)}
                            onChange={() => toggleSession(session)}
                            slotProps={{ input: { 'aria-label': `Import ${session.name}` } }}
                          />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Stack
                              component="span"
                              direction="row"
                              spacing={1}
                              sx={{ alignItems: 'center' }}
                            >
                              <Typography component="span" variant="body2" sx={{ fontWeight: 650 }}>
                                {session.name}
                              </Typography>
                              {session.kind === 'serial' ? (
                                <Chip size="small" variant="outlined" icon={<UsbOutlinedIcon />} label="Serial" />
                              ) : null}
                              {session.folder ? (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  icon={<FolderOutlinedIcon />}
                                  label={session.folder}
                                />
                              ) : null}
                            </Stack>
                          }
                          secondary={sessionDetails(session)}
                        />
                      </ListItem>
                    </Box>
                  );
                })}
              </List>
              {filteredSessions.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>
                  No sessions match that filter.
                </Typography>
              ) : null}
            </Paper>

            {conflictingSessions.length > 0 ? (
              <FormControl>
                <FormLabel>When a Muxus host already matches an imported session</FormLabel>
                <RadioGroup
                  row
                  value={conflicts}
                  onChange={(event) => setConflicts(event.target.value as TransferConflictStrategy)}
                >
                  <FormControlLabel
                    value="keep"
                    control={<Radio />}
                    label={`Keep existing (${conflictingSessions.length})`}
                  />
                  <FormControlLabel value="replace" control={<Radio />} label="Replace existing" />
                </RadioGroup>
              </FormControl>
            ) : null}
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              {sourceIntro}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: autoSource ? 'repeat(2, minmax(0, 1fr))' : '1fr',
                gap: 1.5,
              }}
            >
              {autoSource ? (
                <SourceCard
                  icon={autoSource.icon}
                  title={autoSource.title}
                  description={autoSource.description}
                  action={
                    <Button
                      variant="contained"
                      disabled={busy !== null}
                      startIcon={
                        busy === 'detect' ? (
                          <CircularProgress size={15} color="inherit" />
                        ) : (
                          <SearchOutlinedIcon />
                        )
                      }
                      onClick={() => void detectLocal()}
                    >
                      {busy === 'detect' ? 'Looking…' : 'Find sessions'}
                    </Button>
                  }
                />
              ) : null}
              <SourceCard
                icon={<UploadFileOutlinedIcon color="secondary" />}
                title={`${vendorName} file`}
                description={fileDescription}
                action={
                  <Button
                    variant="outlined"
                    disabled={busy !== null}
                    startIcon={
                      busy === 'file' ? (
                        <CircularProgress size={15} color="inherit" />
                      ) : (
                        <UploadFileOutlinedIcon />
                      )
                    }
                    onClick={() => fileInput.current?.click()}
                  >
                    Choose file
                  </Button>
                }
              />
            </Box>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept={fileAccept}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
                event.target.value = '';
              }}
            />
            <Alert severity="info">{privacyNotice}</Alert>
          </Stack>
        )}

        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>

      <DialogActions>
        <Button onClick={close} disabled={busy !== null}>
          Cancel
        </Button>
        {pending ? (
          <Button
            variant="contained"
            startIcon={
              busy === 'import' ? <CircularProgress size={15} color="inherit" /> : <DnsOutlinedIcon />
            }
            disabled={busy !== null || selectedCount === 0}
            onClick={() => void importSessions()}
          >
            {busy === 'import'
              ? 'Importing…'
              : `Import ${selectedCount} ${selectedCount === 1 ? 'session' : 'sessions'}`}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

function searchableSessionValues(session: ImportedSession): Array<string | undefined> {
  return session.kind === 'ssh'
    ? [session.name, session.alias, session.host, session.username, session.folder]
    : [session.name, session.path, String(session.baudRate), session.folder];
}

function sessionDetails(session: ImportedSession): string {
  if (session.kind === 'ssh') {
    return `${session.username ? `${session.username}@` : ''}${session.host}:${session.port} · ${session.authMode === 'password' ? 'password prompt' : 'SSH key / agent'}`;
  }
  const parity = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[
    session.parity
  ];
  const flow =
    session.flowControl === 'hardware'
      ? 'hardware flow'
      : session.flowControl === 'software'
        ? 'XON/XOFF'
        : 'no flow control';
  return `${session.path} · ${session.baudRate} baud · ${session.dataBits}${parity}${session.stopBits} · ${flow}`;
}

function SourceCard({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', minHeight: 180 }}>
      {icon}
      <Typography variant="subtitle1" sx={{ mt: 1.5, fontWeight: 700 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2, flex: 1 }}>
        {description}
      </Typography>
      <Box>{action}</Box>
    </Paper>
  );
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatMegabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}
