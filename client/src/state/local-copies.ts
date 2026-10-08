import { create } from 'zustand';
import type { TransferProgressState } from '../transfer-progress.js';

/** A remote file opened with a local program, whose saves can be uploaded back. */
export interface TrackedLocalCopy {
  id: string;
  connId: string;
  remotePath: string;
  name: string;
  /** The tab's title, to say where an upload goes. */
  host?: string;
  /** The remote file's modification time the copy started from or was last uploaded as. */
  remoteMtimeMs?: number;
  /** Upload later saves without asking. */
  autoUpload: boolean;
}

export interface LocalCopyUpload extends TransferProgressState {
  /** Distinguishes attempts so a finished one clears only itself. */
  attempt: number;
  copyId: string;
  host?: string;
  cancel: () => void;
}

interface LocalCopiesState {
  copies: Record<string, TrackedLocalCopy>;
  upload?: LocalCopyUpload;
  track: (copy: TrackedLocalCopy) => void;
  update: (id: string, patch: Partial<TrackedLocalCopy>) => void;
  setUpload: (upload: LocalCopyUpload | undefined) => void;
}

export const useLocalCopiesStore = create<LocalCopiesState>()((set) => ({
  copies: {},
  track: (copy) => set((state) => ({ copies: { ...state.copies, [copy.id]: copy } })),
  update: (id, patch) =>
    set((state) => {
      const copy = state.copies[id];
      return copy ? { copies: { ...state.copies, [id]: { ...copy, ...patch } } } : state;
    }),
  setUpload: (upload) => set({ upload }),
}));
