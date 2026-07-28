import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnection } from '../../../server/src/ssh/connection-manager.js';
import { ForwardManager } from '../../../server/src/forwards/forward-manager.js';

describe('ForwardManager lifecycle', () => {
  let manager: ForwardManager | undefined;

  afterEach(() => manager?.stopAll());

  it('stops terminal-owned forwards but preserves explicit tunnels', async () => {
    const release = vi.fn();
    const connection = {
      id: 'connection-1',
      client: {},
      onClose: () => () => undefined,
    } as unknown as ManagedConnection;
    const connections = {
      acquire: () => ({ connection, owner: 'forward' as const, release }),
    };
    manager = new ForwardManager(connections as never, { warn: vi.fn() } as never);

    const session = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0 });
    const tunnel = await manager.start({
      connId: connection.id,
      type: 'dynamic',
      bindPort: 0,
      tunnelId: 'tunnel-1',
    });

    expect(session.lifecycle).toBe('session');
    expect(tunnel.lifecycle).toBe('independent');

    manager.stopSessionForConnection(connection.id);

    expect(manager.list()).toEqual([tunnel]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('promotes a running session forward when it is saved as a tunnel', async () => {
    const release = vi.fn();
    const connection = {
      id: 'connection-1',
      client: {},
      onClose: () => () => undefined,
    } as unknown as ManagedConnection;
    const connections = {
      acquire: () => ({ connection, owner: 'forward' as const, release }),
    };
    manager = new ForwardManager(connections as never, { warn: vi.fn() } as never);
    const session = await manager.start({ connId: connection.id, type: 'dynamic', bindPort: 0 });

    manager.assignTunnel(session.id, 'tunnel-1');
    manager.stopSessionForConnection(connection.id);

    expect(manager.list()).toEqual([
      expect.objectContaining({ id: session.id, tunnelId: 'tunnel-1', lifecycle: 'independent' }),
    ]);
    expect(release).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent config forwards on a multiplexed connection', async () => {
    const release = vi.fn();
    const connection = {
      id: 'connection-1',
      client: {},
      onClose: () => () => undefined,
    } as unknown as ManagedConnection;
    const acquire = vi.fn(() => ({ connection, owner: 'forward' as const, release }));
    manager = new ForwardManager({ acquire } as never, { warn: vi.fn() } as never);
    const request = { connId: connection.id, type: 'dynamic' as const, bindPort: 0 };

    const [first, second] = await Promise.all([
      manager.startConfig(request),
      manager.startConfig(request),
    ]);

    expect(new Set([first.started, second.started])).toEqual(new Set([false, true]));
    expect(first.info.id).toBe(second.info.id);
    expect(manager.list()).toEqual([first.info]);
    expect(acquire).toHaveBeenCalledTimes(1);

    manager.stop(first.info.id);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
