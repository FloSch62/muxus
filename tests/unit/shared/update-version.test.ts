import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '@muxus/shared';

describe('update version precedence', () => {
  it('compares stable core versions', () => {
    expect(isNewerVersion('0.2.0', '0.1.1')).toBe(true);
    expect(isNewerVersion('V10.0.0', 'v9.999.999')).toBe(true);
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
  });

  it('offers the final release to prerelease users', () => {
    expect(isNewerVersion('0.2.0', '0.2.0-beta.1')).toBe(true);
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false);
  });

  it('uses SemVer prerelease precedence and ignores build metadata', () => {
    expect(isNewerVersion('1.0.0-beta.11', '1.0.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0-beta.11')).toBe(true);
    expect(isNewerVersion('1.0.0+build.2', '1.0.0+build.1')).toBe(false);
  });

  it('rejects malformed versions', () => {
    expect(isNewerVersion('1.0', '0.9.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.01', '1.0.0-beta.1')).toBe(false);
  });
});
