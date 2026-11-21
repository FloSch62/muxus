import { describe, expect, it } from 'vitest';
import { forwardsPollInterval } from '../../../client/src/api/queries.js';
import { liveConnectionsKey } from '../../../client/src/forwarding-refresh.js';

describe('the connections a window is on', () => {
  it('changes when a session connects, and again when it ends', () => {
    const idle = liveConnectionsKey([{ connId: undefined }]);
    const connected = liveConnectionsKey([{ connId: 'conn-1' }]);
    expect(connected).not.toBe(idle);
    expect(liveConnectionsKey([{ connId: undefined }])).toBe(idle);
  });

  it('stays the same while tabs only move, or share a connection', () => {
    const key = liveConnectionsKey([{ connId: 'conn-1' }, { connId: 'conn-2' }]);
    expect(liveConnectionsKey([{ connId: 'conn-2' }, { connId: 'conn-1' }])).toBe(key);
    expect(
      liveConnectionsKey([{ connId: 'conn-1' }, { connId: 'conn-2' }, { connId: 'conn-1' }]),
    ).toBe(key);
    expect(liveConnectionsKey([{ connId: 'conn-1' }, { connId: undefined }, { connId: 'conn-2' }])).toBe(key);
  });

  it('tells a reconnect apart, which comes back on a new transport', () => {
    expect(liveConnectionsKey([{ connId: 'conn-1' }])).not.toBe(liveConnectionsKey([{ connId: 'conn-2' }]));
  });
});

describe('how soon the forwards are asked for again', () => {
  it('follows a forward closely while it starts or reconnects', () => {
    expect(forwardsPollInterval([{ status: 'active' }, { status: 'starting' }])).toBe(1_000);
    expect(forwardsPollInterval([{ status: 'reconnecting' }])).toBe(1_000);
  });

  it('falls back to the slow poll once everything has settled', () => {
    expect(forwardsPollInterval(undefined)).toBe(5_000);
    expect(forwardsPollInterval([])).toBe(5_000);
    expect(forwardsPollInterval([{ status: 'active' }, { status: 'error' }])).toBe(5_000);
  });
});
