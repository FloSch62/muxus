import { describe, expect, it } from 'vitest';
import {
  localPtyArgs,
  localStartupInput,
} from '../../../server/src/local/pty-manager.js';

describe('local shell profiles', () => {
  it('keeps shell integration arguments and appends configured arguments', () => {
    expect(
      localPtyArgs(
        { kind: 'local', shell: 'wsl.exe', args: ['-d', 'Ubuntu'] },
        ['--integration'],
      ),
    ).toEqual(['--integration', '-d', 'Ubuntu']);
  });

  it('turns multiline startup commands into PTY Enter presses', () => {
    expect(localStartupInput('  cd project\nnpm run dev  ')).toBe(
      'cd project\rnpm run dev\r',
    );
    expect(localStartupInput('  ')).toBeUndefined();
    expect(localStartupInput(undefined)).toBeUndefined();
  });
});
