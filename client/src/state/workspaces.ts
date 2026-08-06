import { create } from 'zustand';
import type { WorkspaceSummary } from '@muxus/shared';

interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  activeId?: string;
  activeName: string;
  startupId?: string;
  ready: boolean;
  busy: boolean;
  /** Number of other application windows currently showing each workspace. */
  openWindowCounts: Record<string, number>;
  error?: string;
}

/** Read-only workspace catalog state; mutations are serialized by the persistence runtime. */
export const useWorkspacesStore = create<WorkspacesState>()(() => ({
  workspaces: [],
  activeName: 'Unsaved workspace',
  ready: false,
  busy: false,
  openWindowCounts: {},
}));
