import { create } from 'zustand';
import type { SshProfile } from '@muxus/shared';
import { dialProfile, type DialedConnection, type DialHandlers } from '../api/dial.js';
import { cancelScriptRun, scriptRunStatus, startScriptRun } from '../api/scripts.js';
import { gatewayDialHandlers } from '../gateway-forwards.js';
import { hostDisplayName } from '../host-organization.js';
import type { ManagedHost } from '../managed-hosts.js';
import { savedHostDisplayName } from '../saved-hosts.js';
import { showToast } from '../state/toast.js';
import { useUiStore } from '../state/ui.js';
import { runJob, type HostRunState, type RunMode } from './run-plan.js';

const POLL_MS = 500;
/** Output kept per host in the window; the server keeps its own copy too. */
const MAX_OUTPUT = 1024 * 1024;

/** One host of a job. */
export interface HostRun {
  key: string;
  label: string;
  state: HostRunState;
  output: string;
  exitCode?: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ScriptJob {
  id: number;
  scriptName: string;
  mode: RunMode;
  stopOnFailure: boolean;
  startedAt: number;
  endedAt?: number;
  hosts: HostRun[];
  cancelled: boolean;
}

interface ScriptJobState {
  job?: ScriptJob;
  patchHost(jobId: number, key: string, patch: Partial<HostRun> | ((host: HostRun) => Partial<HostRun>)): void;
  setJob(job: ScriptJob | undefined): void;
  patchJob(jobId: number, patch: Partial<ScriptJob>): void;
}

export const useScriptJobStore = create<ScriptJobState>()((set) => ({
  job: undefined,
  setJob: (job) => set({ job }),
  patchJob: (jobId, patch) =>
    set((state) => (state.job?.id === jobId ? { job: { ...state.job, ...patch } } : state)),
  patchHost: (jobId, key, patch) =>
    set((state) => {
      if (state.job?.id !== jobId) return state;
      return {
        job: {
          ...state.job,
          hosts: state.job.hosts.map((host) =>
            host.key === key ? { ...host, ...(typeof patch === 'function' ? patch(host) : patch) } : host,
          ),
        },
      };
    }),
}));

/** A host scripts can run on, with how to reach it. */
export interface ScriptTarget {
  key: string;
  label: string;
  profile: SshProfile;
}

/** SSH hosts only: scripts run over an SSH exec channel. */
export function scriptTarget(host: ManagedHost): ScriptTarget | undefined {
  if (host.kind === 'ssh') {
    return { key: `ssh:${host.entry.alias}`, label: hostDisplayName(host.entry), profile: { kind: 'ssh', target: host.entry.alias } };
  }
  const profile = host.entry.profile;
  if (profile.kind !== 'ssh') return undefined;
  return {
    key: `profile:${host.entry.id}`,
    label: savedHostDisplayName(host.entry),
    profile: { kind: 'ssh', target: profile.target, profileId: host.entry.id },
  };
}

/**
 * Open Scripts with these hosts picked: one host, a selection or a folder.
 * Hosts that cannot run scripts (Telnet, RDP, shares …) are left out.
 */
export function openScriptsFor(hosts: readonly ManagedHost[], what: string): void {
  const keys = hosts.map(scriptTarget).filter((target): target is ScriptTarget => !!target).map((target) => target.key);
  if (keys.length === 0) {
    showToast('info', `${what} has no SSH hosts to run a script on.`);
    return;
  }
  const left = hosts.length - keys.length;
  if (left > 0) showToast('info', `${left} host${left === 1 ? '' : 's'} left out: scripts run on SSH hosts only.`);
  useUiStore.getState().setScriptsDialog({ hostKeys: keys });
}

let nextJobId = 1;
/** Live pieces of the running job, to stop them on cancel. */
const live = { dials: new Set<DialedConnection>(), runs: new Set<string>() };

export function jobRunning(job: ScriptJob | undefined): boolean {
  return !!job && job.endedAt === undefined;
}

/** Start a job, replacing a finished one. */
export function startScriptJob(input: {
  scriptName: string;
  body: string;
  targets: readonly ScriptTarget[];
  mode: RunMode;
  stopOnFailure: boolean;
  timeoutSeconds: number;
}): void {
  const store = useScriptJobStore.getState();
  if (jobRunning(store.job)) throw new Error('A script is still running. Cancel it or wait for it to finish.');
  const jobId = nextJobId++;
  store.setJob({
    id: jobId,
    scriptName: input.scriptName,
    mode: input.mode,
    stopOnFailure: input.stopOnFailure,
    startedAt: Date.now(),
    cancelled: false,
    hosts: input.targets.map((target) => ({ key: target.key, label: target.label, state: 'queued', output: '' })),
  });
  const patch = (key: string, value: Partial<HostRun> | ((host: HostRun) => Partial<HostRun>)) =>
    useScriptJobStore.getState().patchHost(jobId, key, value);
  const cancelled = () => useScriptJobStore.getState().job?.id !== jobId || useScriptJobStore.getState().job!.cancelled;

  void runJob(input.targets, {
    mode: input.mode,
    stopOnFailure: input.stopOnFailure,
    cancelled,
    skip: (target) => patch(target.key, { state: 'skipped' }),
    runOne: (target) => runOnHost(target, input.body, input.timeoutSeconds, patch, cancelled),
  }).finally(() => useScriptJobStore.getState().patchJob(jobId, { endedAt: Date.now() }));
}

export function cancelScriptJob(): void {
  const store = useScriptJobStore.getState();
  const job = store.job;
  if (!jobRunning(job)) return;
  store.patchJob(job!.id, { cancelled: true });
  for (const dial of live.dials) dial.close();
  for (const runId of live.runs) void cancelScriptRun(runId);
}

async function runOnHost(
  target: ScriptTarget,
  body: string,
  timeoutSeconds: number,
  patch: (key: string, value: Partial<HostRun> | ((host: HostRun) => Partial<HostRun>)) => void,
  cancelled: () => boolean,
): Promise<{ state: 'completed' | 'failed' | 'cancelled' }> {
  if (cancelled()) {
    patch(target.key, { state: 'skipped' });
    return { state: 'cancelled' };
  }
  patch(target.key, { state: 'connecting', startedAt: Date.now() });
  const fail = (error: string) => {
    const state = cancelled() ? 'cancelled' : 'failed';
    patch(target.key, { state, error: cancelled() ? undefined : error, endedAt: Date.now() });
    return { state } as const;
  };

  let dialed: DialedConnection;
  try {
    dialed = await dialProfile(target.profile, promptsFor(target));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  live.dials.add(dialed);
  let runId: string;
  try {
    if (cancelled()) return fail('Cancelled.');
    runId = (await startScriptRun({ connId: dialed.connId, body, timeoutSeconds })).id;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    // The run holds its own lease on the connection now.
    live.dials.delete(dialed);
    dialed.close();
  }

  live.runs.add(runId);
  patch(target.key, { state: 'running' });
  let offset = 0;
  try {
    for (;;) {
      const status = await scriptRunStatus(runId, offset);
      offset = status.offset;
      if (status.output) {
        patch(target.key, (host) => {
          const output = host.output + status.output;
          return { output: output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output };
        });
      }
      if (status.state !== 'running') {
        const state = status.state === 'completed' ? 'completed' : status.state === 'cancelled' ? 'cancelled' : 'failed';
        patch(target.key, {
          state,
          ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
          ...(status.error ? { error: status.error } : {}),
          endedAt: Date.now(),
        });
        return { state };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    live.runs.delete(runId);
  }
}

/** The window's sign-in prompts, labelled with the host that asks. */
function promptsFor(target: ScriptTarget): DialHandlers {
  const handlers = gatewayDialHandlers();
  return {
    ...handlers,
    onAuthPrompt: (request) =>
      handlers.onAuthPrompt({ ...request, name: request.name || `Sign in to ${target.label}` }),
  };
}
