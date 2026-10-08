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
