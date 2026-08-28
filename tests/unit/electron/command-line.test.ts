import { describe, expect, it } from 'vitest';
import { parseCommandLineLaunch } from '../../../electron/src/command-line.js';

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
});
