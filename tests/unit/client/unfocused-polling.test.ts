import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostStats } from '../../../client/src/api/host-stats.js';
import { LOCAL_ENVIRONMENT_HOST, refreshConnectedHosts } from '../../../client/src/environments.js';
import { useEnvironmentsStore } from '../../../client/src/state/environments.js';

const { apiFetch, cleanups } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  cleanups: [] as Array<() => void>,
}));

// The status bar's hook runs outside React: its effect starts at once and its
// state is not kept, which is all its polling loop needs.
vi.mock('../../../client/node_modules/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useState: (initial: unknown) => [initial, () => undefined],
}));
vi.mock('../../../client/src/api/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/src/api/http.js')>()),
  apiFetch,
}));

let focused = true;
let visibilityState = 'visible';

beforeEach(() => {
  focused = true;
  visibilityState = 'visible';
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState;
    },
    hasFocus: () => focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  apiFetch.mockReset();
});

const reads = (prefix: string) =>
  apiFetch.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));

describe('status bar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(async () => ({ status: 'ok', sample: {}, sampledAt: Date.now() }));
  });

  it('reads the host every 3 seconds while the window has focus', async () => {
    useHostStats({ kind: 'ssh', connId: 'in-front' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads('/api/host-stats/')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(reads('/api/host-stats/')).toHaveLength(4);
  });

  it('reads it every 15 seconds while the window is not focused', async () => {
    focused = false;
    useHostStats({ kind: 'ssh', connId: 'behind' });
    // The second reading still comes after a second, so rates appear.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads('/api/host-stats/')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(reads('/api/host-stats/')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads('/api/host-stats/')).toHaveLength(3);
  });
});

describe('container and VM refresh', () => {
  beforeEach(() => {
    useEnvironmentsStore.setState({ entries: {}, order: [] });
    useEnvironmentsStore.getState().update(LOCAL_ENVIRONMENT_HOST, { status: 'ready', automatic: true });
    apiFetch.mockResolvedValue({ status: 'ok', environments: [], problems: [], sampledAt: 0 });
  });

  it('reads this computer again while the window has focus', async () => {
    refreshConnectedHosts();
    await vi.waitFor(() => expect(reads('/api/environments/local')).toHaveLength(1));
  });

  it('reads nothing while the window is not focused or hidden', async () => {
    focused = false;
    refreshConnectedHosts();
    focused = true;
    visibilityState = 'hidden';
    refreshConnectedHosts();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(useEnvironmentsStore.getState().entries.local?.status).toBe('ready');
  });
});
