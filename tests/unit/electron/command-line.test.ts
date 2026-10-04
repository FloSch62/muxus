import { describe, expect, it } from 'vitest';
import {
  canHandleCommandLineLaunch,
  parseCommandLineLaunch,
  parseCommandLineLaunchData,
  parseConnectTarget,
} from '../../../electron/src/command-line.js';

describe('desktop command-line launch parsing', () => {
  it('accepts split and equals forms among unrelated Electron arguments', () => {
    expect(parseCommandLineLaunch(['muxus', '--host', 'edge-1'])).toEqual({
      kind: 'host',
      name: 'edge-1',
    });
    expect(
      parseCommandLineLaunch(['electron', '.', '--inspect=9229', '--folder=Production/EU']),
    ).toEqual({ kind: 'folder', name: 'Production/EU' });
    expect(parseCommandLineLaunch(['muxus', '--workspace', 'Night shift'])).toEqual({
      kind: 'workspace',
      name: 'Night shift',
    });
  });

  it('ignores invocations without a desktop launch target', () => {
    expect(parseCommandLineLaunch(['muxus'])).toBeUndefined();
    expect(parseCommandLineLaunch(['muxus', '--no-sandbox'])).toBeUndefined();
  });

  it('rejects missing, empty, oversized, and competing targets', () => {
    expect(parseCommandLineLaunch(['muxus', '--host'])).toBeUndefined();
    expect(parseCommandLineLaunch(['muxus', '--host='])).toBeUndefined();
    expect(parseCommandLineLaunch(['muxus', '--host', '--workspace', 'Lab'])).toBeUndefined();
    expect(
      parseCommandLineLaunch(['muxus', '--host', 'edge', '--folder', 'Lab']),
    ).toBeUndefined();
    expect(parseCommandLineLaunch(['muxus', `--host=${'x'.repeat(501)}`])).toBeUndefined();
  });

  it('validates structured second-instance launch data', () => {
    expect(parseCommandLineLaunchData({ kind: 'workspace', name: ' Night shift ' })).toEqual({
      kind: 'workspace',
      name: 'Night shift',
    });
    expect(parseCommandLineLaunchData({ kind: 'host', name: 'edge-1' })).toEqual({
      kind: 'host',
      name: 'edge-1',
    });
    expect(parseCommandLineLaunchData({ kind: 'unknown', name: 'edge-1' })).toBeUndefined();
    expect(parseCommandLineLaunchData({ kind: 'folder', name: '' })).toBeUndefined();
  });

  it('revalidates forwarded ad-hoc connection targets', () => {
    expect(
      parseCommandLineLaunchData({ kind: 'connect', name: 'admin@10.10.10.1:2222' }),
    ).toEqual({ kind: 'connect', name: 'admin@10.10.10.1:2222' });
    expect(
      parseCommandLineLaunchData({ kind: 'connect', name: '[fe80::1]:2222' }),
    ).toEqual({ kind: 'connect', name: '[fe80::1]:2222' });
    expect(
      parseCommandLineLaunchData({ kind: 'connect', name: 'edge;reboot' }),
    ).toBeUndefined();
  });
});

describe('desktop command-line ad-hoc connections', () => {
  it('accepts a [user@]host[:port] target in split and equals forms', () => {
    expect(parseCommandLineLaunch(['muxus', '--connect', 'admin@10.10.10.1'])).toEqual({
      kind: 'connect',
      name: 'admin@10.10.10.1',
    });
    expect(parseCommandLineLaunch(['muxus', '--connect=admin@10.10.10.1:2222'])).toEqual({
      kind: 'connect',
      name: 'admin@10.10.10.1:2222',
    });
    expect(parseCommandLineLaunch(['muxus', '--connect', 'edge-1.example.test'])).toEqual({
      kind: 'connect',
      name: 'edge-1.example.test',
    });
  });

  it('folds separate --user and --port flags into the target', () => {
    expect(
      parseCommandLineLaunch([
        'muxus',
        '--connect',
        '10.10.10.1',
        '--user',
        'admin',
        '--port',
        '2222',
      ]),
    ).toEqual({ kind: 'connect', name: 'admin@10.10.10.1:2222' });
    expect(
      parseCommandLineLaunch(['muxus', '--port=2222', '--user=admin', '--connect=10.10.10.1']),
    ).toEqual({ kind: 'connect', name: 'admin@10.10.10.1:2222' });
    expect(parseCommandLineLaunch(['muxus', '--connect', 'edge', '--port', '0022'])).toEqual({
      kind: 'connect',
      name: 'edge:22',
    });
  });

  it('brackets IPv6 hosts only when a port follows them', () => {
    expect(parseConnectTarget('fe80::1')).toBe('fe80::1');
    expect(parseConnectTarget('admin@fe80::1', { port: '2222' })).toBe('admin@[fe80::1]:2222');
    expect(parseConnectTarget('[2001:db8::5]:830')).toBe('[2001:db8::5]:830');
    expect(parseConnectTarget('[2001:db8::5]')).toBe('2001:db8::5');
    expect(parseConnectTarget('fe80::1%eth0', { port: '22' })).toBe('[fe80::1%eth0]:22');
  });

  it('rejects a user or port given twice', () => {
    expect(
      parseCommandLineLaunch(['muxus', '--connect', 'admin@edge', '--user', 'root']),
    ).toBeUndefined();
    expect(
      parseCommandLineLaunch(['muxus', '--connect', 'edge:22', '--port', '2222']),
    ).toBeUndefined();
    expect(
      parseCommandLineLaunch(['muxus', '--connect', 'edge', '--port', '22', '--port', '23']),
    ).toBeUndefined();
  });

  it('rejects --user and --port without --connect', () => {
    expect(parseCommandLineLaunch(['muxus', '--host', 'edge', '--port', '22'])).toBeUndefined();
    expect(parseCommandLineLaunch(['muxus', '--user', 'admin'])).toBeUndefined();
  });

  it('rejects malformed ports and shell-sensitive names', () => {
    for (const target of [
      'edge:0',
      'edge:65536',
      'edge:',
      'edge:ssh',
      '@edge',
      'admin@',
      '-oProxyCommand=sh',
      'admin@-edge',
      'edge;reboot',
      'edge$(id)',
      'ad min@edge',
      '`id`@edge',
      '[edge;id]:22',
    ]) {
      expect(parseConnectTarget(target), target).toBeUndefined();
    }
    expect(parseConnectTarget('edge', { user: '-oProxyCommand=sh' })).toBeUndefined();
    expect(parseConnectTarget('edge', { port: '22;id' })).toBeUndefined();
    expect(
      parseCommandLineLaunch(['muxus', '--connect', 'edge', '--user', 'a|b']),
    ).toBeUndefined();
  });
});

describe('desktop command-line window routing', () => {
  it('excludes SFTP-only windows from launch request delivery', () => {
    expect(canHandleCommandLineLaunch(undefined)).toBe(true);
    expect(
      canHandleCommandLineLaunch({
        kind: 'workspace',
        workspaceId: 'operations',
        title: 'Operations',
      }),
    ).toBe(true);
    expect(
      canHandleCommandLineLaunch({
        kind: 'session',
        profile: { kind: 'local' },
        title: 'Local',
      }),
    ).toBe(true);
    expect(
      canHandleCommandLineLaunch({ kind: 'sftp', connId: 'ssh-1', title: 'Files' }),
    ).toBe(false);
  });
});
