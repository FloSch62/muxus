import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareQueryChanges } from '../../../client/src/query-sync.js';

type SharedClient = Parameters<typeof shareQueryChanges>[0];

class TestBroadcastChannel {
  static readonly instances = new Set<TestBroadcastChannel>();
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    TestBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    if (!TestBroadcastChannel.instances.has(this)) throw new Error('InvalidStateError');
    this.posted.push(data);
    for (const channel of TestBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    TestBroadcastChannel.instances.delete(this);
    this.listeners.clear();
  }
}

/** A window: the query client methods the sharing wraps, and its channel. */
function testWindow() {
  const invalidateQueries = vi.fn(async (_filters?: unknown) => undefined);
  const setQueryData = vi.fn((_key: unknown, updater: unknown) => updater);
  const client = { invalidateQueries, setQueryData };
  const channel = new TestBroadcastChannel('queries');
  const stop = shareQueryChanges(
    client as unknown as SharedClient,
    channel as unknown as BroadcastChannel,
  );
  return { client, invalidateQueries, setQueryData, channel, stop };
}

/** Let the queued per-task flush run. */
const settle = () => Promise.resolve();

afterEach(() => {
  TestBroadcastChannel.instances.clear();
});

describe('query changes shared between windows', () => {
  it('marks what one window invalidates stale in the others', async () => {
    const settings = testWindow();
    const app = testWindow();

    void settings.client.invalidateQueries({ queryKey: ['ssh-config'] });
    expect(settings.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['ssh-config'] }, undefined);
    expect(app.invalidateQueries).not.toHaveBeenCalled();

    await settle();
    expect(app.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['ssh-config'] });
  });

  it('treats data one window replaces after a write as stale elsewhere', async () => {
    const settings = testWindow();
    const app = testWindow();

    const status = { locked: false };
    expect(settings.client.setQueryData(['password-vault'], status)).toBe(status);
    await settle();

    expect(settings.setQueryData).toHaveBeenCalledWith(['password-vault'], status, undefined);
    expect(app.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['password-vault'] });
    expect(app.setQueryData).not.toHaveBeenCalled();
  });

  it('sends one message per task, without duplicate keys', async () => {
    const settings = testWindow();
    const app = testWindow();

    void settings.client.invalidateQueries({ queryKey: ['ssh-config'] });
    void settings.client.invalidateQueries({ queryKey: ['saved-host-profiles'] });
    void settings.client.invalidateQueries({ queryKey: ['ssh-config'] });
    await settle();

    expect(settings.channel.posted).toEqual([
      { kind: 'stale', queryKeys: [['ssh-config'], ['saved-host-profiles']] },
    ]);
    expect(app.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['ssh-config'] }],
      [{ queryKey: ['saved-host-profiles'] }],
    ]);
  });

  it('refreshes everything when the change cannot be named by a key', async () => {
    const settings = testWindow();
    const app = testWindow();

    void settings.client.invalidateQueries({ queryKey: ['tunnels'] });
    void settings.client.invalidateQueries({ predicate: () => true });
    await settle();
    void settings.client.invalidateQueries();
    await settle();

    expect(settings.channel.posted).toEqual([
      { kind: 'stale', queryKeys: [null] },
      { kind: 'stale', queryKeys: [null] },
    ]);
    expect(app.invalidateQueries.mock.calls).toEqual([[undefined], [undefined]]);
  });

  it('never passes a received change on again', async () => {
    const settings = testWindow();
    const app = testWindow();
    const other = testWindow();

    void settings.client.invalidateQueries({ queryKey: ['tunnels'] });
    await settle();
    await settle();

    expect(app.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(other.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(settings.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(app.channel.posted).toEqual([]);
    expect(other.channel.posted).toEqual([]);
  });

  it('stops sharing when torn down, and the client keeps working', async () => {
    const settings = testWindow();
    const app = testWindow();

    void settings.client.invalidateQueries({ queryKey: ['tunnels'] });
    settings.stop();
    await settle();
    void settings.client.invalidateQueries({ queryKey: ['forwards'] });
    settings.client.setQueryData(['password-vault'], { locked: true });
    await settle();

    expect(settings.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(settings.setQueryData).toHaveBeenCalledTimes(1);
    expect(settings.channel.posted).toEqual([]);
    expect(app.invalidateQueries).not.toHaveBeenCalled();
  });
});
