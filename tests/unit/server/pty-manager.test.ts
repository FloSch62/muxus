import { describe, expect, it } from 'vitest';
import {
  localPtyArgs,
  localShellPromptReady,
  localStartupInput,
  spawnLocalPty,
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

it.skipIf(process.platform === 'win32')('resizes an interactive Bun PTY and drains its final output before exit', async () => {
  let output = '';
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const terminal = spawnLocalPty({ kind: 'local', shell: '/bin/sh', args: ['-i'] }, 80, 24, {
    data: (data) => { output += data; }, exit: finish,
  });
  try {
    terminal.resize(123, 41);
    terminal.write("stty size; printf '\\303'; printf '\\251-final\\n'; exit 7\r");
    expect(await exited).toBe(7);
    expect(output).toContain('41 123');
    expect(output).toContain('é-final');
    expect(output).not.toContain('job control turned off');
  } finally { terminal.kill(); }
});

it.skipIf(process.platform === 'win32')('delivers Ctrl+C to the foreground PTY process', async () => {
  let output = '';
  let ready!: () => void;
  let finish!: (code: number) => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const terminal = spawnLocalPty({ kind: 'local', shell: '/bin/sh', args: ['-i'] }, 80, 24, {
    data: (data) => { output += data; if (output.includes('foreground-ready')) ready(); }, exit: finish,
  });
  try {
    terminal.write("printf 'foreground-%s\\n' ready; exec sleep 30\r");
    await started;
    terminal.write('\x03');
    expect(await exited).toBe(130);
  } finally { terminal.kill(); }
});
