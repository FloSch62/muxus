import { describe, expect, it } from 'vitest';
import {
  localPtyArgs,
  localShellPromptReady,
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

  it('waits for an integrated or visible interactive prompt', () => {
    expect(localShellPromptReady('Loading profile...\r\n')).toBe(false);
    expect(localShellPromptReady('Password: ')).toBe(false);
    expect(localShellPromptReady('\x1b]133;A\x07')).toBe(true);
    expect(localShellPromptReady('\x1b]633;A;Prompt\x1b\\')).toBe(true);
    expect(localShellPromptReady('\x1b[32muser@host\x1b[0m $ ')).toBe(true);
    expect(localShellPromptReady('PS C:\\work> ')).toBe(true);
  });
});
