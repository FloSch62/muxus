import { describe, expect, it } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import {
  filterSavedHosts,
  savedHostAddress,
} from '../../../client/src/saved-hosts.js';

const profiles: SavedHostProfile[] = [
  {
    id: 'serial-console',
    kind: 'serial',
    name: 'Rack console',
    profile: {
      kind: 'serial',
      profileId: 'serial-console',
      path: 'COM3',
      baudRate: 115_200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    },
    metadata: {
      profileId: 'serial-console',
      favorite: false,
      group: 'Lab',
      connectCount: 0,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'telnet-router',
    kind: 'telnet',
    name: 'Core router',
    profile: {
      kind: 'telnet',
      profileId: 'telnet-router',
      host: 'router.example.test',
      port: 2323,
    },
    metadata: {
      profileId: 'telnet-router',
      favorite: true,
      connectCount: 4,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

describe('saved host search', () => {
  it('searches native hosts by name, kind, group, and address', () => {
    expect(filterSavedHosts(profiles, 'lab').map((host) => host.id)).toEqual([
      'serial-console',
    ]);
    expect(filterSavedHosts(profiles, 'telnet').map((host) => host.id)).toEqual([
      'telnet-router',
    ]);
    expect(filterSavedHosts(profiles, '2323').map((host) => host.id)).toEqual([
      'telnet-router',
    ]);
  });

  it('sorts favorites first and formats platform-native addresses', () => {
    expect(filterSavedHosts(profiles, '').map((host) => host.id)).toEqual([
      'telnet-router',
      'serial-console',
    ]);
    expect(savedHostAddress(profiles[0]!)).toBe('COM3 · 115200 baud');
    expect(savedHostAddress(profiles[1]!)).toBe('router.example.test:2323');
  });
});
