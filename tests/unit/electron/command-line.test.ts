import { describe, expect, it } from 'vitest';
import {
  canHandleCommandLineLaunch,
  parseCommandLineLaunch,
  parseCommandLineLaunchData,
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
