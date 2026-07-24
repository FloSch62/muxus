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

  it('accepts cross-platform Telnet and serial session launches', () => {
    const telnet: AppWindowLaunch = {
      kind: 'session',
      profile: {
        kind: 'telnet',
        profileId: 'saved-router',
        host: 'router.local',
        port: 2323,
      },
      title: 'Router console',
    };
    const serial: AppWindowLaunch = {
      kind: 'session',
      profile: {
        kind: 'serial',
        path: 'COM3',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'hardware',
      },
      title: 'COM3',
    };
    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(telnet))).toEqual(telnet);
    expect(decodeAppWindowLaunch(encodeAppWindowLaunch(serial))).toEqual(serial);
  });

  it('rejects malformed or unsupported payloads', () => {
    expect(isAppWindowLaunch({ kind: 'session', title: 'Missing profile' })).toBe(false);
    expect(
      isAppWindowLaunch({
        kind: 'session',
        title: 'Invalid saved host',
        profile: {
          kind: 'telnet',
          profileId: { unexpected: true },
          host: 'router.local',
          port: 23,
        },
      }),
    ).toBe(false);
    expect(isAppWindowLaunch({ kind: 'sftp', connId: '', title: 'Empty connection' })).toBe(false);
    expect(decodeAppWindowLaunch('not-base64-json')).toBeUndefined();
  });
});
