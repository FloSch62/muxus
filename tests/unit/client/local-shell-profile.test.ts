import { describe, expect, it } from 'vitest';
import {
  localShellLaunchArguments,
  parseLocalShellArgumentText,
} from '../../../client/src/local-shell-profile.js';

describe('local shell profile arguments', () => {
  it('preserves trailing and intermediate blank rows while editing', () => {
    expect(parseLocalShellArgumentText('-d\n')).toEqual(['-d', '']);
    expect(parseLocalShellArgumentText('-d\n\nUbuntu')).toEqual(['-d', '', 'Ubuntu']);
  });

  it('discards blank editor rows only when launching', () => {
    expect(localShellLaunchArguments(['-d', '', 'Ubuntu', ''])).toEqual([
      '-d',
      'Ubuntu',
    ]);
    expect(localShellLaunchArguments([''])).toBeUndefined();
  });
});
