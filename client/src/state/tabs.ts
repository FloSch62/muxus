import { create } from 'zustand';
import type { SessionProfile } from '@muxus/shared';

export type TabStatus = 'connecting' | 'connected' | 'closed';

export interface TerminalTab {
  id: string;
  title: string;
  profile: SessionProfile;
  status: TabStatus;
  /** Live connection id from the server's `ready` (SSH only) — keys SFTP/forwards. */
  connId?: string;
  /** SFTP file panel visible for this tab. */
  sftpOpen: boolean;
}

interface TabsState {
  tabs: TerminalTab[];
  activeId: string | null;
  open: (profile: SessionProfile, title: string) => string;
  close: (id: string) => void;
  activate: (id: string) => void;
  cycle: (backwards: boolean) => void;
  update: (id: string, patch: Partial<Pick<TerminalTab, 'title' | 'status' | 'connId' | 'sftpOpen'>>) => void;
}

let nextTab = 1;

/** Open terminal tabs — transient by design: sessions die with the server,
 *  so restoring tab state across launches would only restore dead shells. */
export const useTabsStore = create<TabsState>()((set) => ({
  tabs: [],
  activeId: null,
  open: (profile, title) => {
    const id = `t${nextTab++}`;
    set((s) => ({
      tabs: [...s.tabs, { id, title, profile, status: 'connecting', sftpOpen: false }],
      activeId: id,
    }));
    return id;
  },
  close: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeId;
      return { tabs, activeId };
    }),
  activate: (id) => set({ activeId: id }),
  cycle: (backwards) =>
    set((s) => {
      if (s.tabs.length < 2) return s;
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      const next = (idx + (backwards ? -1 : 1) + s.tabs.length) % s.tabs.length;
      return { activeId: s.tabs[next]!.id };
    }),
  update: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
}));
