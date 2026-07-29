import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import LaptopWindowsOutlinedIcon from '@mui/icons-material/LaptopWindowsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import type { SvgIconComponent } from '@mui/icons-material';
import { useAppInfo } from '../api/queries.js';
import {
  MAX_TRANSFER_FILE_BYTES,
  createBackupDocument,
  createOpenSshExport,
  datedTransferFilename,
  fetchDataSummary,
  parseTransferDocument,
  restoreTransferDocument,
  saveTransferDocument,
  type RestoreSelection,
  type TransferConflictStrategy,
  type TransferDocument,
} from '../data-transfer.js';
import { saveTextFile } from '../save-file.js';
import { muxusStateStorage } from '../state/persist-storage.js';
import { errorDetails, showToast } from '../state/toast.js';

const LAST_BACKUP_KEY = 'muxus-last-backup-at';

type BusyAction = 'backup' | 'openssh' | null;

interface PendingFile {
  document: TransferDocument;
  filename: string;
}

export function DataTransferSection({
  onImportMobaXterm,
}: {
  onImportMobaXterm: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: appInfo } = useAppInfo();
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['data-transfer-summary'],
    queryFn: fetchDataSummary,
    staleTime: 10_000,
  });
  const restoreInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve(muxusStateStorage.getItem(LAST_BACKUP_KEY)).then(
      (value) => {
        if (
          active &&
          value &&
          !Number.isNaN(Date.parse(value))
        ) {
          setLastBackup(value);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const createBackup = async () => {
    setBusy('backup');
    try {
      const document = await createBackupDocument(appInfo?.version);
      saveTransferDocument(document, datedTransferFilename());
      muxusStateStorage.setItem(LAST_BACKUP_KEY, document.createdAt);
      setLastBackup(document.createdAt);
      showToast('success', 'Backup saved.');
    } catch (error) {
      showToast(
        'error',
        error instanceof Error ? error.message : 'Could not create the backup.',
        errorDetails(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const exportOpenSsh = async () => {
    setBusy('openssh');
    try {
      const text = await createOpenSshExport();
      const date = new Date().toISOString().slice(0, 10);
      saveTextFile(
        `muxus-openssh-connections-${date}.conf`,
        text,
        'text/plain',
      );
      showToast('success', 'OpenSSH config export saved.');
    } catch (error) {
      showToast(
        'error',
        error instanceof Error
          ? error.message
          : 'Could not export the connections.',
        errorDetails(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_TRANSFER_FILE_BYTES) {
      showToast('error', 'That file is too large for a Muxus settings transfer.');
      return;
    }
    try {
      const document = parseTransferDocument(await file.text());
      setPending({ document, filename: file.name });
    } catch (error) {
      showToast(
        'error',
        error instanceof Error ? error.message : 'Could not read that file.',
        errorDetails(error),
      );
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  const invalidateRestoredData = () => {
    void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
    void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    void queryClient.invalidateQueries({ queryKey: ['tunnels'] });
    void queryClient.invalidateQueries({
      queryKey: ['session-logging-policy'],
    });
    void queryClient.invalidateQueries({
      queryKey: ['session-history-storage'],
    });
    void queryClient.invalidateQueries({
      queryKey: ['data-transfer-summary'],
    });
  };

  const statLine = summaryLoading
    ? 'Reading your Muxus data…'
    : summary
      ? [
          plural(summary.connections, 'connection'),
          plural(summary.tunnels, 'tunnel'),
        ].join('  ·  ')
      : 'Settings, connections, tunnels and logging policies';

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 700 }}>
          Backup & restore
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.5, maxWidth: 620 }}
        >
          Keep one portable copy of your Muxus setup, then restore everything
          or only the parts you need.
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 1.5,
        }}
      >
        <Paper
          variant="outlined"
          sx={(theme) => ({
            p: 2.25,
            minHeight: 210,
            display: 'flex',
            flexDirection: 'column',
            borderColor: alpha(theme.palette.primary.main, 0.28),
            background: `linear-gradient(145deg, ${alpha(theme.palette.primary.main, 0.1)}, ${alpha(theme.palette.background.paper, 0.2)} 65%)`,
          })}
        >
          <Stack
            direction="row"
            sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
          >
            <IconTile icon={BackupOutlinedIcon} tone="primary" />
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label="Recommended"
            />
          </Stack>
          <Typography variant="subtitle1" sx={{ mt: 1.5, fontWeight: 700 }}>
            Back up your setup
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, flex: 1 }}
          >
            {statLine}. One portable file, ready for another Muxus install.
          </Typography>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{ alignItems: 'center', mt: 1.75 }}
          >
            <Button
              variant="contained"
              startIcon={
                busy === 'backup' ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <DownloadOutlinedIcon />
                )
              }
              disabled={busy !== null}
              onClick={() => void createBackup()}
            >
              {busy === 'backup' ? 'Creating…' : 'Create backup'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              {lastBackup
                ? `Last: ${friendlyDate(lastBackup)}`
                : 'No backup yet'}
            </Typography>
          </Stack>
        </Paper>

        <Paper
          variant="outlined"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setDragActive(false);
            }
          }}
          onDrop={handleDrop}
          sx={(theme) => ({
            p: 2.25,
            minHeight: 210,
            display: 'flex',
            flexDirection: 'column',
            borderStyle: dragActive ? 'dashed' : 'solid',
            borderWidth: dragActive ? 2 : 1,
            borderColor:
              dragActive
                ? theme.palette.primary.main
                : theme.palette.divider,
            bgcolor:
              dragActive
                ? alpha(theme.palette.primary.main, 0.07)
                : 'background.paper',
          })}
        >
          <IconTile icon={CloudDoneOutlinedIcon} tone="success" />
          <Typography variant="subtitle1" sx={{ mt: 1.5, fontWeight: 700 }}>
            Restore a backup
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, flex: 1 }}
          >
            Review what is inside and restore everything—or select only the
            categories you need.
          </Typography>
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ alignItems: 'center', mt: 1.75 }}
          >
            <Button
              variant="outlined"
              startIcon={<UploadFileOutlinedIcon />}
              disabled={busy !== null}
              onClick={() => restoreInput.current?.click()}
            >
              Choose backup
            </Button>
            <Typography variant="caption" color="text.secondary">
              or drop it here
            </Typography>
          </Stack>
          <input
            ref={restoreInput}
            hidden
            type="file"
            accept=".muxus,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
              event.target.value = '';
            }}
          />
        </Paper>
      </Box>

      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'center' }, p: 2.25 }}
        >
          <IconTile icon={DnsOutlinedIcon} tone="secondary" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              OpenSSH export
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Export SSH hosts as a standard config for other SSH clients.
              Muxus-specific settings remain in the backup above.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={
              busy === 'openssh' ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <DownloadOutlinedIcon />
              )
            }
            disabled={busy !== null}
            onClick={() => void exportOpenSsh()}
          >
            {busy === 'openssh' ? 'Exporting…' : 'Export OpenSSH'}
          </Button>
        </Stack>
        <Divider />
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', px: 2.25, py: 1.25 }}
        >
          <LockOutlinedIcon
            sx={{ fontSize: 16, color: 'text.secondary' }}
          />
          <Typography variant="caption" color="text.secondary">
            Private key files, passwords and recorded session history are never
            embedded. Key file paths are retained so profiles still know where
            to look.
          </Typography>
        </Stack>
      </Paper>

      <Paper variant="outlined">
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'center' }, p: 2.25 }}
        >
          <IconTile icon={LaptopWindowsOutlinedIcon} tone="primary" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              MobaXterm import
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Review and import SSH sessions from a local Windows installation
              or a MobaXterm session file.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<LaptopWindowsOutlinedIcon />}
            onClick={onImportMobaXterm}
          >
            Import sessions
          </Button>
        </Stack>
      </Paper>

      {pending ? (
        <RestoreReviewDialog
          key={`${pending.filename}:${pending.document.createdAt}`}
          pending={pending}
          onClose={() => setPending(null)}
          onRestored={invalidateRestoredData}
        />
      ) : null}
    </Stack>
  );
}

function RestoreReviewDialog({
  pending,
  onClose,
  onRestored,
}: {
  pending: PendingFile;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [selection, setSelection] = useState<RestoreSelection>({
    preferences: true,
    connections: true,
    tunnels: true,
    logging: true,
  });
  const [conflicts, setConflicts] =
    useState<TransferConflictStrategy>('keep');
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectionCount =
    pending.document.data.sshHosts.length +
    pending.document.data.savedHosts.length;
  const categories = [
    {
      key: 'preferences' as const,
      icon: SettingsOutlinedIcon,
      label: 'App settings',
      detail: 'Appearance, terminal, behavior and global highlighting',
      count: undefined,
    },
    {
      key: 'connections' as const,
      icon: DnsOutlinedIcon,
      label: 'Connections',
      detail: 'SSH, Telnet and serial profiles',
      count: connectionCount,
    },
    {
      key: 'tunnels' as const,
      icon: AltRouteOutlinedIcon,
      label: 'Tunnels',
      detail: 'Saved port-forwarding definitions',
      count: pending.document.data.tunnels.length,
    },
    {
      key: 'logging' as const,
      icon: HistoryOutlinedIcon,
      label: 'Logging settings',
      detail: 'Policies and retention limits; no recordings',
      count: pending.document.data.loggingPolicies.length,
    },
  ];
  const selectedCount = Object.values(selection).filter(Boolean).length;

  const restore = async () => {
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreTransferDocument(
        pending.document,
        selection,
        conflicts,
      );
      onRestored();
      const summary = [
        result.added ? `${result.added} added` : '',
        result.updated ? `${result.updated} updated` : '',
        result.skipped ? `${result.skipped} kept` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      showToast(
        'success',
        `Restore complete${summary ? ` — ${summary}` : ''}.`,
      );
      onClose();
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : 'The transfer could not be completed.',
      );
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog
      open
      onClose={restoring ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <IconTile icon={CloudDoneOutlinedIcon} tone="success" compact />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Restore this backup?
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {pending.filename} · {friendlyDate(pending.document.createdAt)}
              {pending.document.appVersion
                ? ` · Muxus ${pending.document.appVersion}`
                : ''}
            </Typography>
          </Box>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ py: 0 }}>
        <List disablePadding>
          {categories.map((category) => (
            <ListItem
              key={category.key}
              disableGutters
              secondaryAction={
                category.count === undefined ? null : (
                  <Chip
                    variant="outlined"
                    label={category.count}
                    sx={{ minWidth: 36 }}
                  />
                )
              }
              sx={{ py: 0.5, pr: 6 }}
            >
              <Checkbox
                edge="start"
                checked={selection[category.key]}
                onChange={(event) =>
                  setSelection((current) => ({
                    ...current,
                    [category.key]: event.target.checked,
                  }))
                }
                slotProps={{
                  input: { 'aria-label': `Restore ${category.label}` },
                }}
              />
              <ListItemIcon sx={{ minWidth: 36 }}>
                <category.icon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={category.label}
                secondary={category.detail}
                slotProps={{ primary: { variant: 'body2' } }}
              />
            </ListItem>
          ))}
        </List>

        <Divider />
        <FormControl sx={{ py: 2, width: '100%' }}>
          <FormLabel
            sx={{
              color: 'text.primary',
              typography: 'subtitle2',
              fontWeight: 700,
            }}
          >
            When an item already exists
          </FormLabel>
          <RadioGroup
            value={conflicts}
            onChange={(event) =>
              setConflicts(event.target.value as TransferConflictStrategy)
            }
          >
            <FormControlLabel
              value="keep"
              control={<Radio size="small" />}
              label={
                <Box>
                  <Typography variant="body2">Keep the current item</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Safest. Only missing items are added.
                  </Typography>
                </Box>
              }
            />
            <FormControlLabel
              value="replace"
              control={<Radio size="small" />}
              label={
                <Box>
                  <Typography variant="body2">
                    Replace it with the file’s version
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Matches by SSH alias or Muxus item ID.
                  </Typography>
                </Box>
              }
            />
          </RadioGroup>
          {selection.preferences || selection.logging ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.5 }}
            >
              App and logging settings are replaced when selected; the choice
              above applies to saved connections and tunnels.
            </Typography>
          ) : null}
        </FormControl>

        <Alert severity="info" sx={{ mb: 2 }}>
          This is a merge: items that are not in the file are never deleted.
          Active terminal sessions are not interrupted.
        </Alert>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error} Some items may already have been restored; it is safe to
            review the file and try again.
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 2.5, py: 1.5 }}>
        <Button onClick={onClose} disabled={restoring}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={restoring || selectedCount === 0}
          startIcon={
            restoring ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <CloudDoneOutlinedIcon />
            )
          }
          onClick={() => void restore()}
        >
          {restoring ? 'Restoring…' : 'Restore selected'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function IconTile({
  icon: Icon,
  tone,
  compact = false,
}: {
  icon: SvgIconComponent;
  tone: 'primary' | 'secondary' | 'success';
  compact?: boolean;
}) {
  return (
    <Box
      sx={(theme) => ({
        width: compact ? 34 : 40,
        height: compact ? 34 : 40,
        borderRadius: compact ? 1 : 1.25,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        color: theme.palette[tone].main,
        bgcolor: alpha(theme.palette[tone].main, 0.12),
      })}
    >
      <Icon fontSize={compact ? 'small' : 'medium'} />
    </Box>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function friendlyDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay
      ? {}
      : { year: 'numeric', month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
