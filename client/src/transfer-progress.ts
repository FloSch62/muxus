import { showErrorToast, showToast } from './state/toast.js';

/** One file transfer as the progress bar shows it. */
export interface TransferProgressState {
  direction: 'upload' | 'download';
  name: string;
  loaded: number;
  total?: number;
  bytesPerSecond: number;
  phase: 'preparing' | 'transferring' | 'finalizing' | 'cancelling' | 'complete';
  fileIndex?: number;
  fileCount?: number;
}

/** The reason the progress bar's Cancel aborts with: only it reads as cancelled. */
export const TRANSFER_CANCELLED = new DOMException('Transfer cancelled', 'AbortError');

/** The reason a transfer aborts with when its session loses the connection. */
export const CONNECTION_LOST = new DOMException('Connection lost', 'AbortError');

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Say why a transfer stopped with `error`: cancelled after Cancel, the lost
 * connection, or the failure itself. Aborted for any other reason, as when its
 * file browser closes, it stops without a message.
 */
export function reportStoppedTransfer(
  error: unknown,
  signal: AbortSignal,
  messages: { cancelled: string; connectionLost: string },
): void {
  if (signal.reason === TRANSFER_CANCELLED) showToast('info', messages.cancelled);
  else if (signal.reason === CONNECTION_LOST) showToast('error', messages.connectionLost);
  else if (!signal.aborted || !isAbortError(error)) showErrorToast(error);
}
