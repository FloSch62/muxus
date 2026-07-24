import { describe, expect, it } from 'vitest';
import type { AppWindowLaunch } from '@muxus/shared';
import {
  decodeAppWindowLaunch,
  encodeAppWindowLaunch,
  isAppWindowLaunch,
} from '../../../client/src/window-management.js';

describe('secondary window launch payloads', () => {
  it('round-trips unicode session titles and complete profiles', () => {
    const launch: AppWindowLaunch = {
      kind: 'session',
      profile: { kind: 'ssh', target: 'edge-router', user: 'operator', port: 2222 },
      title: 'München — 边缘',
      color: '#42a5f5',
    };

    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(launch))).toEqual(launch);
  });

  it('round-trips an SFTP location', () => {
    const launch: AppWindowLaunch = {
      kind: 'sftp',
      connId: 'connection-1',
      title: 'Production',
      path: '/var/log',
    };

    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(launch))).toEqual(launch);
  });

  it('rejects malformed or unsupported payloads', () => {
    expect(isAppWindowLaunch({ kind: 'session', title: 'Missing profile' })).toBe(false);
    expect(isAppWindowLaunch({ kind: 'sftp', connId: '', title: 'Empty connection' })).toBe(false);
    expect(decodeAppWindowLaunch('not-base64-json')).toBeUndefined();
  });
});
