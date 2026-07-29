import { useMemo, useRef, useState } from 'react';
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
import LaptopWindowsOutlinedIcon from '@mui/icons-material/LaptopWindowsOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useSshConfig } from '../api/queries.js';
import {
  restoreImportedConnections,
  type TransferConflictStrategy,
} from '../data-transfer.js';
import {
  MAX_MOBAXTERM_IMPORT_BYTES,
  mobaXtermConnections,
  parseMobaXtermSessions,
  type MobaXtermParseResult,
  type MobaXtermSession,
} from '../mobaxterm-import.js';
import { errorDetails, showToast } from '../state/toast.js';

interface PendingImport {
  source: string;
  parsed: MobaXtermParseResult;
}

export function MobaXtermImportDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: sshConfig } = useSshConfig();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [conflicts, setConflicts] =
    useState<TransferConflictStrategy>('keep');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'detect' | 'file' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canAutoDetect =
    window.muxusDesktop?.platform === 'win32' &&
    typeof window.muxusDesktop.readMobaXtermSessions === 'function';

  const existingAliases = useMemo(
    () => new Set(sshConfig?.hosts.map((host) => host.alias) ?? []),
    [sshConfig?.hosts],
  );
  const conflictingSessions = useMemo(
    () =>
      pending?.parsed.sessions.filter((session) =>
        existingAliases.has(session.alias),
      ) ?? [],
    [existingAliases, pending?.parsed.sessions],
  );
  const filteredSessions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!pending || !needle) return pending?.parsed.sessions ?? [];
    return pending.parsed.sessions.filter((session) =>
      [
        session.name,
        session.alias,
        session.host,
        session.username,
        session.folder,
      ].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [pending, search]);

  const review = (content: string, source: string) => {
    const parsed = parseMobaXtermSessions(content);
    setPending({ source, parsed });
    setSelected(new Set(parsed.sessions.map((session) => session.id)));
    setSearch('');
    setError(null);
  };

  const detectLocal = async () => {
    const desktop = window.muxusDesktop;
    if (!desktop?.readMobaXtermSessions) return;
    setBusy('detect');
    setError(null);
    try {
      const source = await desktop.readMobaXtermSessions();
      if (source) review(source.content, source.source);
    } catch (detectError) {
      setError(messageFrom(detectError, 'Could not read local MobaXterm sessions.'));
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_MOBAXTERM_IMPORT_BYTES) {
      setError('That MobaXterm file is larger than 10 MB.');
      return;
    }
    setBusy('file');
    setError(null);
    try {
      review(await file.text(), file.name);
    } catch (fileError) {
      setError(messageFrom(fileError, 'Could not read that MobaXterm file.'));
    } finally {
      setBusy(null);
    }
  };

  const toggleSession = (session: MobaXtermSession) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
  };

  const importSessions = async () => {
    if (!pending) return;
    const included = pending.parsed.sessions.filter((session) =>
      selected.has(session.id),
    );
    if (included.length === 0) return;
    setBusy('import');
    setError(null);
    try {
      const result = await restoreImportedConnections(
        mobaXtermConnections(included),
        conflicts,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ssh-config'] }),
        queryClient.invalidateQueries({ queryKey: ['data-transfer-summary'] }),
      ]);
      const summary = [
        result.added ? `${result.added} added` : '',
        result.updated ? `${result.updated} replaced` : '',
        result.skipped ? `${result.skipped} kept` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      showToast('success', `MobaXterm import complete${summary ? ` — ${summary}` : ''}.`);
      onClose();
    } catch (importError) {
      setError(messageFrom(importError, 'The MobaXterm sessions could not be imported.'));
      showToast(
        'error',
        messageFrom(importError, 'The MobaXterm sessions could not be imported.'),
        errorDetails(importError),
      );
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
            <LaptopWindowsOutlinedIcon color="primary" />
          )}
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Import from MobaXterm
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {pending
                ? `${pending.parsed.sessions.length} SSH sessions from ${pending.source}`
                : 'Bring your saved SSH sessions and folders into Muxus.'}
            </Typography>
          </Box>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {pending ? (
          <Stack spacing={2}>
            <Alert severity="info">
              Passwords and private key files are not copied. Muxus will use your
              SSH agent or ask for credentials when you connect.
            </Alert>
            {pending.parsed.ignoredCount > 0 ? (
              <Alert severity="warning">
                {pending.parsed.ignoredCount} unsupported or incomplete{' '}
                {pending.parsed.ignoredCount === 1 ? 'bookmark was' : 'bookmarks were'} skipped.
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
                      <SearchOutlinedIcon
                        sx={{ mr: 1, fontSize: 19, color: 'text.secondary' }}
                      />
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
                {filteredSessions.map((session, index) => (
                  <Box key={session.id}>
                    {index > 0 ? <Divider /> : null}
                    <ListItem
                      secondaryAction={
                        existingAliases.has(session.alias) ? (
                          <Chip size="small" color="warning" label="Already exists" />
                        ) : null
                      }
                      sx={{
                        pr: existingAliases.has(session.alias) ? 16 : 2,
                        contentVisibility: 'auto',
                        containIntrinsicSize: '56px',
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 38 }}>
                        <Checkbox
                          edge="start"
                          checked={selected.has(session.id)}
                          onChange={() => toggleSession(session)}
                          slotProps={{
                            input: { 'aria-label': `Import ${session.name}` },
                          }}
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
                        secondary={`${session.username ? `${session.username}@` : ''}${session.host}:${session.port} · ${session.authMode === 'password' ? 'password prompt' : 'SSH key / agent'}`}
                      />
                    </ListItem>
                  </Box>
                ))}
              </List>
              {filteredSessions.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ p: 3, textAlign: 'center' }}
                >
                  No sessions match that filter.
                </Typography>
              ) : null}
            </Paper>

            {conflictingSessions.length > 0 ? (
              <FormControl>
                <FormLabel>When a Muxus host already uses the same alias</FormLabel>
                <RadioGroup
                  row
                  value={conflicts}
                  onChange={(event) =>
                    setConflicts(event.target.value as TransferConflictStrategy)
                  }
                >
                  <FormControlLabel
                    value="keep"
                    control={<Radio />}
                    label={`Keep existing (${conflictingSessions.length})`}
                  />
                  <FormControlLabel
                    value="replace"
                    control={<Radio />}
                    label="Replace existing"
                  />
                </RadioGroup>
              </FormControl>
            ) : null}
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              On Windows, Muxus can find bookmark data from the installed or
              portable edition. You can also choose an exported file on any
              platform.
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: canAutoDetect ? 'repeat(2, minmax(0, 1fr))' : '1fr',
                gap: 1.5,
              }}
            >
              {canAutoDetect ? (
                <SourceCard
                  icon={<LaptopWindowsOutlinedIcon color="primary" />}
                  title="Local MobaXterm"
                  description="Read SSH bookmark names, hosts and folders from this Windows account."
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
                title="MobaXterm file"
                description="Choose MobaXterm.ini, .mxtsessions, .mobaconf or a text export."
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
              accept=".ini,.mxtsessions,.mobaconf,.txt,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
                event.target.value = '';
              }}
            />
            <Alert severity="info">
              Muxus only reads connection metadata. It never imports MobaXterm
              passwords or writes secrets into your SSH config.
            </Alert>
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
              busy === 'import' ? (
                <CircularProgress size={15} color="inherit" />
              ) : (
                <DnsOutlinedIcon />
              )
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
