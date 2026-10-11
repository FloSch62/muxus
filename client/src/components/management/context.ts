import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ManagementProfile } from '@muxus/shared';
import type { WorkbenchController } from '../../management/controller.js';
import type { WorkbenchState, WorkbenchStore } from '../../management/workbench-store.js';

export interface WorkbenchContextValue {
  controller: WorkbenchController;
  store: WorkbenchStore;
  /** The session is up: requests can run. */
  connected: boolean;
  profile: ManagementProfile;
  /** Display name of the host (the tab title). */
  title: string;
}

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error('useWorkbench outside a management workbench');
  return value;
}

export function useWorkbenchState<T>(selector: (state: WorkbenchState) => T): T {
  return useStore(useWorkbench().store, selector);
}
