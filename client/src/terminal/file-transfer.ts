import type { FileTransferProtocol, FileTransferState, SessionProfile } from '@muxus/shared';
import type { TransferProgressState } from '../transfer-progress.js';

export type FileTransferDirection = FileTransferState['direction'];

export interface FileTransferOption {
  protocol: FileTransferProtocol;
  label: string;
  /** What the choice means, for the dialog. */
  hint: string;
  /** Sends a batch rather than one file. */
  batch: boolean;
  /** The sender does not name the file, so the receiving side must. */
  needsName: boolean;
}

export const FILE_TRANSFER_OPTIONS: readonly FileTransferOption[] = [
  {
    protocol: 'xmodem',
    label: 'XMODEM (checksum)',
    hint: '128-byte blocks with an 8-bit checksum, for the oldest receivers.',
    batch: false,
    needsName: true,
  },
  {
    protocol: 'xmodem-crc',
    label: 'XMODEM-CRC',
    hint: '128-byte blocks with CRC-16 (loadx, ROMMON xmodem).',
    batch: false,
    needsName: true,
  },
  {
    protocol: 'xmodem-1k',
    label: 'XMODEM-1K',
    hint: '1024-byte blocks with CRC-16.',
    batch: false,
    needsName: true,
  },
  {
    protocol: 'ymodem',
    label: 'YMODEM',
    hint: 'Batches with names and exact sizes (loady, rb, sb).',
    batch: true,
    needsName: false,
  },
  {
    protocol: 'zmodem',
    label: 'ZMODEM',
    hint: 'Streaming with error recovery (rz, sz).',
    batch: true,
    needsName: false,
  },
];

export const PROTOCOL_NAMES: Record<FileTransferProtocol, string> = {
  xmodem: 'XMODEM',
  'xmodem-crc': 'XMODEM-CRC',
  'xmodem-1k': 'XMODEM-1K',
  ymodem: 'YMODEM',
  zmodem: 'ZMODEM',
};

export function fileTransferOption(protocol: FileTransferProtocol): FileTransferOption {
  return FILE_TRANSFER_OPTIONS.find((option) => option.protocol === protocol)!;
}

/** XMODEM, YMODEM and ZMODEM run on the byte streams of these sessions. */
export function supportsFileTransfer(profile: Pick<SessionProfile, 'kind'> | null | undefined): boolean {
  return profile?.kind === 'ssh' || profile?.kind === 'telnet' || profile?.kind === 'serial';
}

/** What the remote side has to be running before the transfer starts here. */
export function remoteCommandHint(direction: FileTransferDirection, protocol: FileTransferProtocol): string {
  if (direction === 'send') {
    if (protocol === 'zmodem') return 'Muxus types rz for you; a shell that has it starts receiving.';
    if (protocol === 'ymodem') return 'Start the receiver first: loady in U-Boot, rb in a shell.';
    return 'Start the receiver first: loadx in U-Boot, xmodem in ROMMON, rx in a shell.';
  }
  if (protocol === 'zmodem') return 'Start sz on the remote side; Muxus also notices it by itself.';
  if (protocol === 'ymodem') return 'Start the sender first, for example sb.';
  return 'Start the sender first, for example sx.';
}

export const ACTIVE_TRANSFER_PHASES: ReadonlySet<FileTransferState['phase']> = new Set([
  'waiting',
  'transferring',
  'cancelling',
]);

export function isFinished(state: FileTransferState): boolean {
  return state.phase === 'complete' || state.phase === 'cancelled' || state.phase === 'failed';
}

/** The progress bar's label: what is moving, which way, and how. */
export function transferLabel(state: FileTransferState, host: string | undefined): string {
  const protocol = PROTOCOL_NAMES[state.protocol];
  const remote = host ?? 'the remote side';
  if (state.phase === 'cancelling') return `Cancelling the ${protocol} transfer…`;
  if (state.phase === 'waiting' || !state.fileName) {
    return state.direction === 'send'
      ? `Waiting for ${remote} to start receiving (${protocol})…`
      : `Waiting for ${remote} to start sending (${protocol})…`;
  }
  return state.direction === 'send'
    ? `Sending ${state.fileName} to ${remote} with ${protocol}`
    : `Receiving ${state.fileName} from ${remote} with ${protocol}`;
}

export function toProgressState(state: FileTransferState): TransferProgressState {
  return {
    direction: state.direction === 'send' ? 'upload' : 'download',
    name: state.fileName ?? '',
    loaded: state.bytes,
    total: state.total,
    bytesPerSecond: state.bytesPerSecond,
    phase:
      state.phase === 'cancelling'
        ? 'cancelling'
        : state.phase === 'complete'
          ? 'complete'
          : state.phase === 'transferring'
            ? 'transferring'
            : 'preparing',
    fileIndex: state.fileIndex,
    fileCount: state.fileCount,
  };
}

/** Received files not yet handed to the browser for saving. */
export function unsavedFiles(state: FileTransferState, saved: ReadonlySet<string>): FileTransferState['received'] {
  return state.received.filter((file) => !saved.has(file.id));
}

/** The toast once a transfer is over. */
export function transferOutcome(
  state: FileTransferState,
): { severity: 'success' | 'info' | 'warning' | 'error'; message: string } {
  const protocol = PROTOCOL_NAMES[state.protocol];
  if (state.phase === 'complete') {
    if (state.direction === 'receive') {
      const count = state.received.length;
      return {
        severity: 'success',
        message:
          count === 1
            ? `Received ${state.received[0]!.name} with ${protocol}`
            : `Received ${count} files with ${protocol}`,
      };
    }
    const skipped = state.skipped ?? [];
    if (skipped.length > 0) {
      return {
        severity: 'warning',
        message: `The remote side skipped ${skipped.join(', ')}, usually because ${
          skipped.length === 1 ? 'it already exists' : 'they already exist'
        } there.`,
      };
    }
    const count = state.fileCount ?? 1;
    return {
      severity: 'success',
      message:
        count === 1 && state.fileName
          ? `Sent ${state.fileName} with ${protocol}`
          : `Sent ${count} files with ${protocol}`,
    };
  }
  if (state.phase === 'cancelled') {
    return {
      severity: 'info',
      message: state.message === 'Declined.' ? `Declined the ${protocol} transfer` : `${protocol} transfer cancelled`,
    };
  }
  return { severity: 'error', message: `${protocol} transfer failed: ${state.message ?? 'unknown error'}` };
}
