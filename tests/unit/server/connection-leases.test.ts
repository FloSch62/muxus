import { describe, expect, it, vi } from 'vitest';
import { ConnectionLeaseRegistry } from '../../../server/src/ssh/connection-leases.js';

function connection(id = 'connection-1') {
  return { id, close: vi.fn() };
}

describe('ConnectionLeaseRegistry', () => {
  it('keeps a transport alive until its final independent consumer releases it', () => {
    const registry = new ConnectionLeaseRegistry<ReturnType<typeof connection>>();
    const transport = connection();
    const terminal = registry.register(transport, 'terminal');
    const forward = registry.acquire(transport.id, 'forward')!;
    const sftp = registry.acquire(transport.id, 'sftp')!;

    terminal.release();
    sftp.release();
    expect(transport.close).not.toHaveBeenCalled();
    expect(registry.get(transport.id)).toBe(transport);

    forward.release();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(registry.acquire(transport.id, 'editor')).toBeUndefined();

    forward.release();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('invalidates leases when the remote transport closes first', () => {
    const registry = new ConnectionLeaseRegistry<ReturnType<typeof connection>>();
    const transport = connection();
    const terminal = registry.register(transport, 'terminal');
    const forward = registry.acquire(transport.id, 'forward')!;

    registry.markClosed(transport);
    terminal.release();
    forward.release();

    expect(registry.get(transport.id)).toBeUndefined();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it('supports the tunnel-start handover: dial lease released after a forward holds its own', () => {
    const registry = new ConnectionLeaseRegistry<ReturnType<typeof connection>>();
    const transport = connection();
    const dial = registry.register(transport, 'dial');
    const forward = registry.acquire(transport.id, 'forward')!;

    // The dial socket closes once the forward is up; the tunnel survives.
    dial.release();
    expect(transport.close).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([transport]);

    // Stopping the tunnel releases the final lease and the transport closes.
    forward.release();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(registry.list()).toEqual([]);
  });

  it('force-closes every registered transport during application shutdown', () => {
    const registry = new ConnectionLeaseRegistry<ReturnType<typeof connection>>();
    const first = connection('first');
    const second = connection('second');
    registry.register(first, 'terminal');
    registry.register(second, 'forward');

    registry.closeAll();

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(registry.get('first')).toBeUndefined();
    expect(registry.get('second')).toBeUndefined();
  });
});
