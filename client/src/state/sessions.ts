import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { muxusStateStorage } from './persist-storage.js';

export interface SavedSession {
  id: string;
  name: string;
  host: string;
  port?: number;
  user?: string;
  auth: 'agent' | 'key' | 'password';
  keyPath?: string;
  /** Optional group header the sidebar sorts under. */
  group?: string;
}

interface SessionsState {
  sessions: SavedSession[];
  save: (session: SavedSession) => void;
  remove: (id: string) => void;
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Saved SSH sessions — the persistent session manager (client-owned; the
 *  server only ever sees a profile at connect time). */
export const useSessionsStore = create<SessionsState>()(
  persist(
    (set) => ({
      sessions: [],
      save: (session) =>
        set((s) => {
          const idx = s.sessions.findIndex((x) => x.id === session.id);
          const sessions = [...s.sessions];
          if (idx >= 0) sessions[idx] = session;
          else sessions.push(session);
          return { sessions };
        }),
      remove: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
    }),
    { name: 'muxus-sessions', version: 0, storage: createJSONStorage(() => muxusStateStorage) },
  ),
);
