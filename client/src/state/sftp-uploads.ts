import { create } from 'zustand';
import type { TransferProgressState } from '../transfer-progress.js';

/** Files dropped onto an SSH terminal, on their way to the session's host. */
export interface TerminalUpload extends TransferProgressState {
  /** Distinguishes uploads so a finished one clears only itself. */
  id: number;
  connId: string;
  /** The tab's title, to say where the files go. */
  host?: string;
  cancel: () => void;
}

interface SftpUploadsState {
  /** At most one upload per connection, by connection id. */
  uploads: Record<string, TerminalUpload>;
  /** File browsers on screen, by the connection they show. */
  browsers: Record<string, number>;
  show: (upload: TerminalUpload) => void;
  clear: (connId: string, id: number) => void;
  /** A file browser for the connection came on screen; returns its removal. */
  attachBrowser: (connId: string) => () => void;
}

export const useSftpUploadsStore = create<SftpUploadsState>()((set) => ({
  uploads: {},
  browsers: {},
  show: (upload) => set((state) => ({ uploads: { ...state.uploads, [upload.connId]: upload } })),
  clear: (connId, id) =>
    set((state) => {
      if (state.uploads[connId]?.id !== id) return state;
      const uploads = { ...state.uploads };
      delete uploads[connId];
      return { uploads };
    }),
  attachBrowser: (connId) => {
    set((state) => ({ browsers: { ...state.browsers, [connId]: (state.browsers[connId] ?? 0) + 1 } }));
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      set((state) => {
        const browsers = { ...state.browsers };
        const count = (browsers[connId] ?? 1) - 1;
        if (count > 0) browsers[connId] = count;
        else delete browsers[connId];
        return { browsers };
      });
    };
  },
}));
