import { create } from 'zustand';
import type { EnvironmentProblem, HostEnvironment, SshProfile } from '@muxus/shared';

/** The key of this computer's own entry. Hosts use their managed-host key. */
export const LOCAL_ENVIRONMENT_KEY = 'local';

/** A host whose containers, clusters and VMs Muxus can list. */
export interface EnvironmentHost {
  key: string;
  label: string;
  /** How sessions on this host connect; absent for this computer. */
  profile?: SshProfile;
  color?: string;
}

export type EnvironmentStatus =
  /** Being read now; earlier results, if any, stay visible. */
  | 'loading'
  | 'ready'
  /** The host cannot run commands (a router CLI, a console server). */
  | 'unsupported'
  | 'error'
  /** No live connection to read it over; connecting again reads it. */
  | 'offline';

export interface HostEnvironmentsEntry extends EnvironmentHost {
  status: EnvironmentStatus;
  message?: string;
  environments: HostEnvironment[];
  problems: EnvironmentProblem[];
  sampledAt?: number;
  /** Read without being asked, on connect. */
  automatic: boolean;
}

interface EnvironmentsState {
  entries: Record<string, HostEnvironmentsEntry>;
  /** Insertion order, so the panel lists hosts in the order they were found. */
  order: string[];
  update: (host: EnvironmentHost, patch: Partial<HostEnvironmentsEntry>) => void;
  remove: (key: string) => void;
}

export const useEnvironmentsStore = create<EnvironmentsState>()((set) => ({
  entries: {},
  order: [],
  update: (host, patch) =>
    set((state) => {
      const previous = state.entries[host.key];
      const entry: HostEnvironmentsEntry = {
        status: 'loading',
        environments: [],
        problems: [],
        automatic: true,
        ...previous,
        ...host,
        ...patch,
      };
      return {
        entries: { ...state.entries, [host.key]: entry },
        order: previous ? state.order : [...state.order, host.key],
      };
    }),
  remove: (key) =>
    set((state) => {
      if (!state.entries[key]) return state;
      const { [key]: _removed, ...entries } = state.entries;
      return { entries, order: state.order.filter((candidate) => candidate !== key) };
    }),
}));
