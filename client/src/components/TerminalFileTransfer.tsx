import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type {
  FileTransferProtocol,
  FileTransferState,
  SessionProfile,
  TerminalClientMessage,
} from '@muxus/shared';
import { discardStagedFile, fetchReceivedFile, stageTerminalFile } from '../api/terminal-files.js';
import { saveBlobFile } from '../save-file.js';
import { showErrorToast, showToast } from '../state/toast.js';
import {
  ACTIVE_TRANSFER_PHASES,
  FILE_TRANSFER_OPTIONS,
  fileTransferOption,
  isFinished,
  PROTOCOL_NAMES,
  remoteCommandHint,
  toProgressState,
  transferLabel,
  transferOutcome,
  unsavedFiles,
  type FileTransferDirection,
} from '../terminal/file-transfer.js';
import type { TransferProgressState } from '../transfer-progress.js';
import { formatSize, TransferProgress } from './TransferProgress.js';

export type FileTransferMessage = Extract<
  TerminalClientMessage,
  { op: 'file-transfer-start' | 'file-transfer-cancel' }
>;

/**
 * Finished transfers and saved files, across renderers of the same window:
 * a reattached terminal replays the last transfer state and must not toast
 * or download it twice.
 */
const handledTransfers = new Set<string>();
const savedFiles = new Set<string>();
/** The protocol picked last time, per direction. */
const lastProtocol: Partial<Record<FileTransferDirection, FileTransferProtocol>> = {};

/** A size that never breaks across lines ("5.7 MiB"). */
const size = (bytes: number) => formatSize(bytes).replace(' ', '\u00a0');

function defaultProtocol(direction: FileTransferDirection, kind: SessionProfile['kind']): FileTransferProtocol {
  return lastProtocol[direction] ?? (kind === 'ssh' ? 'zmodem' : 'ymodem');
}

interface Staging {
  progress: TransferProgressState;
  controller: AbortController;
}

/**
 * Send and receive dialogs, the answer to a ZMODEM transfer the remote side
 * started, and the progress panel over the terminal while one runs.
 */
export function TerminalFileTransfer({
  host,
  profileKind,
  transfer,
  request,
  onRequestClose,
  send,
  onDone,
}: {
  /** The remote side as messages name it. */
  host: string;
  profileKind: SessionProfile['kind'];
  transfer: FileTransferState | undefined;
  /** A Send file… or Receive file… choice from a menu. */
  request: FileTransferDirection | null;
  onRequestClose: () => void;
  /** Writes a control frame to the terminal socket; false once it is closed. */
  send: (message: FileTransferMessage) => boolean;
  /** Give the keyboard back to the terminal. */
  onDone: () => void;
}) {
  const [protocol, setProtocol] = useState<FileTransferProtocol>('zmodem');
  const [files, setFiles] = useState<File[]>([]);
  const [fileName, setFileName] = useState('xmodem.bin');
  const [staging, setStaging] = useState<Staging | null>(null);
  const [answeredOffer, setAnsweredOffer] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Files picked for an `rz` offer go straight out; a dialog pick waits for Send. */
  const pickForOfferRef = useRef(false);

  // Closing the picker on an `rz` offer brings the offer back.
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const onCancel = () => {
      if (!pickForOfferRef.current) return;
      pickForOfferRef.current = false;
      setAnsweredOffer(null);
    };
    input.addEventListener('cancel', onCancel);
    return () => input.removeEventListener('cancel', onCancel);
  }, []);

  useEffect(() => {
    if (!request) return;
    setProtocol(defaultProtocol(request, profileKind));
    setFiles([]);
  }, [request, profileKind]);

  useEffect(() => {
    if (!transfer || !isFinished(transfer) || handledTransfers.has(transfer.id)) return;
    handledTransfers.add(transfer.id);
    const outcome = transferOutcome(transfer);
    showToast(outcome.severity, outcome.message);
    onDone();
  }, [transfer, onDone]);

  // Each received file is offered for saving as soon as it is complete.
  useEffect(() => {
    if (!transfer) return;
    for (const file of unsavedFiles(transfer, savedFiles)) {
      savedFiles.add(file.id);
      fetchReceivedFile(file.id, () => undefined).then(
        (blob) => saveBlobFile(file.name, blob),
        (error: unknown) => showErrorToast(error),
      );
    }
  }, [transfer]);

  const stageAndStart = async (picked: File[], chosen: FileTransferProtocol) => {
    const controller = new AbortController();
    const ids: string[] = [];
    const update = (progress: Partial<TransferProgressState>) =>
      setStaging((current) =>
        current && current.controller === controller
          ? { controller, progress: { ...current.progress, ...progress } }
          : current,
      );
    setStaging({
      controller,
      progress: {
        direction: 'upload',
        name: picked[0]?.name ?? '',
        loaded: 0,
        total: picked[0]?.size,
        bytesPerSecond: 0,
        phase: 'preparing',
        fileIndex: 1,
        fileCount: picked.length,
      },
    });
    try {
      for (const [index, file] of picked.entries()) {
        update({ name: file.name, loaded: 0, total: file.size, fileIndex: index + 1 });
        const staged = await stageTerminalFile(
          file,
          (progress) => update({ ...progress, phase: 'preparing' }),
          controller.signal,
        );
        ids.push(staged.id);
      }
      if (controller.signal.aborted) throw new DOMException('Transfer cancelled', 'AbortError');
      if (!send({ op: 'file-transfer-start', direction: 'send', protocol: chosen, files: ids })) {
        throw new Error('The session is no longer connected.');
      }
    } catch (error) {
      for (const id of ids) void discardStagedFile(id).catch(() => undefined);
      if (!(error instanceof DOMException && error.name === 'AbortError')) showErrorToast(error);
      onDone();
    } finally {
      setStaging((current) => (current?.controller === controller ? null : current));
    }
  };

  const option = fileTransferOption(protocol);
  const startManual = () => {
    if (!request) return;
    lastProtocol[request] = protocol;
    onRequestClose();
    if (request === 'send') {
      void stageAndStart(option.batch ? files : files.slice(0, 1), protocol);
      return;
    }
    if (
      !send({
        op: 'file-transfer-start',
        direction: 'receive',
        protocol,
        ...(option.needsName ? { fileName: fileName.trim() || 'xmodem.bin' } : {}),
      })
    ) {
      showToast('error', 'The session is no longer connected.');
    }
  };

  const pickFiles = (multiple: boolean) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.multiple = multiple;
    input.click();
  };

  const offer = transfer?.phase === 'offer' && answeredOffer !== transfer.id ? transfer : undefined;
  const answerOffer = (accept: boolean) => {
    if (!offer) return;
    setAnsweredOffer(offer.id);
    if (!accept) {
      send({ op: 'file-transfer-cancel' });
      onDone();
      return;
    }
    if (offer.direction === 'receive') {
      send({ op: 'file-transfer-start', direction: 'receive', protocol: 'zmodem' });
      return;
    }
    pickForOfferRef.current = true;
    pickFiles(true);
  };

  const showPanel = staging !== null || (transfer !== undefined && ACTIVE_TRANSFER_PHASES.has(transfer.phase));
  const cancel = () => {
    if (staging) {
      staging.controller.abort();
      if (transfer?.phase === 'offer') send({ op: 'file-transfer-cancel' });
      return;
    }
    send({ op: 'file-transfer-cancel' });
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (pickForOfferRef.current) {
            pickForOfferRef.current = false;
            if (picked.length) void stageAndStart(picked, 'zmodem');
            else setAnsweredOffer(null);
            return;
          }
          if (picked.length) setFiles(picked);
        }}
      />

      {showPanel && (
        <Paper
          component="output"
          elevation={8}
          aria-label="File transfer"
          sx={{
            display: 'block',
            position: 'absolute',
            zIndex: 6,
            left: '50%',
            bottom: 18,
            transform: 'translateX(-50%)',
            width: 'min(460px, calc(100% - 32px))',
            border: 1,
            borderColor: 'divider',
          }}
        >
          <TransferProgress
            transfer={staging ? staging.progress : toProgressState(transfer!)}
            label={staging ? `Preparing ${staging.progress.name}…` : transferLabel(transfer!, host)}
            onCancel={cancel}
            sx={{ border: 0 }}
          />
        </Paper>
      )}

      <Dialog open={!!offer && !staging} onClose={() => answerOffer(false)} maxWidth="xs" fullWidth>
        {offer?.direction === 'receive' ? (
          <>
            <DialogTitle>Receive files from {host}?</DialogTitle>
            <DialogContent>
              <DialogContentText>
                {host} started a ZMODEM transfer of <strong>{offer.fileName}</strong>
                {offer.total !== undefined ? ` (${size(offer.total)})` : ''}
                {(offer.fileCount ?? 1) > 1
                  ? ` and ${(offer.fileCount ?? 1) - 1} more ${(offer.fileCount ?? 1) === 2 ? 'file' : 'files'}${
                      offer.batchTotal !== undefined ? `, ${size(offer.batchTotal)} in all` : ''
                    }`
                  : ''}
                . Each file is saved as it arrives.
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => answerOffer(false)}>Decline</Button>
              <Button variant="contained" onClick={() => answerOffer(true)}>
                Receive
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogTitle>Send files to {host}?</DialogTitle>
            <DialogContent>
              <DialogContentText>
                {host} is waiting to receive files with ZMODEM (rz). Choose the files to send.
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => answerOffer(false)}>Cancel</Button>
              <Button variant="contained" onClick={() => answerOffer(true)}>
                Choose files…
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog open={request !== null} onClose={onRequestClose} maxWidth="xs" fullWidth>
        <DialogTitle>{request === 'send' ? `Send files to ${host}` : `Receive files from ${host}`}</DialogTitle>
        <DialogContent>
          <RadioGroup
            aria-label="Protocol"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as FileTransferProtocol)}
          >
            {FILE_TRANSFER_OPTIONS.map((choice) => (
              <FormControlLabel
                key={choice.protocol}
                value={choice.protocol}
                control={<Radio size="small" />}
                label={
                  <Box sx={{ py: 0.25 }}>
                    <Typography variant="body2">{choice.label}</Typography>
                    <Typography variant="caption" color="textSecondary">
                      {choice.hint}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
          {request === 'send' && (
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, mt: 2 }}>
              <Button
                variant="outlined"
                onClick={() => {
                  pickForOfferRef.current = false;
                  pickFiles(option.batch);
                }}
              >
                {option.batch ? 'Choose files…' : 'Choose file…'}
              </Button>
              <Typography variant="body2" color="textSecondary" noWrap sx={{ minWidth: 0 }}>
                {files.length === 0
                  ? 'Nothing chosen'
                  : (option.batch ? files : files.slice(0, 1))
                      .map((file) => `${file.name} (${size(file.size)})`)
                      .join(', ')}
              </Typography>
            </Stack>
          )}
          {request === 'receive' && option.needsName && (
            <TextField
              label="Save as"
              size="small"
              fullWidth
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              helperText="XMODEM sends no file name. The file keeps the sender's padding to a whole block."
              sx={{ mt: 2 }}
            />
          )}
          {request && (
            <Typography variant="caption" color="textSecondary" component="p" sx={{ mt: 2 }}>
              {remoteCommandHint(request, protocol)} Terminal output pauses until the transfer ends.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onRequestClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={request === 'send' && files.length === 0}
            onClick={startManual}
          >
            {request === 'send' ? `Send with ${PROTOCOL_NAMES[protocol]}` : `Receive with ${PROTOCOL_NAMES[protocol]}`}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
