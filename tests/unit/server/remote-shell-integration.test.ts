import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  openIntegratedRemoteShell,
  parseShellProbe,
  remoteShellCommand,
} from '../../../server/src/ssh/remote-shell-integration.js';

class StubChannel extends EventEmitter {
  destroy(): this {
    return this;
  }
}

describe('remote shell integration', () => {
  it('probes, installs, and opens an integrated remote shell', async () => {
    const probeChannel = new StubChannel();
    const terminalChannel = new StubChannel();
    const commands: string[] = [];
    const exec = vi.fn((
      command: string,
      optionsOrCallback: unknown,
      possibleCallback?: unknown,
    ) => {
      commands.push(command);
      const callback = (possibleCallback ?? optionsOrCallback) as (
        error: Error | undefined,
        channel: unknown,
      ) => void;
      if (possibleCallback) {
        callback(undefined, terminalChannel);
      } else {
        callback(undefined, probeChannel);
        setImmediate(() => {
          probeChannel.emit(
            'data',
            Buffer.from('__MUXUS_SHELL__=/usr/bin/zsh\n__MUXUS_ZDOTDIR__=\n'),
          );
          probeChannel.emit('close');
        });
      }
    });
    const writes: string[] = [];
    const directory = {
      isDirectory: () => true,
    };
    const sftp = {
      realpath: (_remotePath: string, callback: (error: Error | undefined, value: string) => void) =>
        callback(undefined, '/home/u'),
      stat: (_remotePath: string, callback: (error: Error | undefined, value: typeof directory) => void) =>
        callback(undefined, directory),
      mkdir: (
        _remotePath: string,
        _attributes: unknown,
        callback: (error?: Error) => void,
      ) => callback(),
      writeFile: (
        remotePath: string,
        _content: string,
        _options: unknown,
        callback: (error?: Error) => void,
      ) => {
        writes.push(remotePath);
        callback();
      },
    };

    const result = await openIntegratedRemoteShell(
      { exec } as never,
      async () => sftp as never,
      { term: 'xterm-256color', cols: 80, rows: 24 },
    );

    expect(result).toBe(terminalChannel);
    expect(commands[0]).toContain('"${SHELL-}" "${ZDOTDIR-}"');
    expect(commands[0]).not.toContain('\\${SHELL-}');
    expect(commands[1]).toContain(
      "export ZDOTDIR='/home/u/.cache/muxus/shell-integration/v1/zsh'",
    );
    expect(writes).toEqual([
      '/home/u/.cache/muxus/shell-integration/v1/zsh/.zshenv',
      '/home/u/.cache/muxus/shell-integration/v1/zsh/.zprofile',
      '/home/u/.cache/muxus/shell-integration/v1/zsh/.zshrc',
    ]);
  });

  it('detects supported shells among startup output', () => {
    expect(parseShellProbe('banner\n__MUXUS_SHELL__=/usr/bin/zsh\n__MUXUS_ZDOTDIR__=/home/u/.config/zsh\n')).toEqual({
      path: '/usr/bin/zsh',
      kind: 'zsh',
      zdotdir: '/home/u/.config/zsh',
    });
    expect(parseShellProbe('__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n')).toEqual({
      path: '/bin/bash',
      kind: 'bash',
    });
  });

  it('rejects unsupported and missing shells', () => {
    expect(parseShellProbe('__MUXUS_SHELL__=/usr/bin/fish\n__MUXUS_ZDOTDIR__=\n')).toBeUndefined();
    expect(parseShellProbe('')).toBeUndefined();
  });

  it('starts zsh through the cached shim and preserves a custom ZDOTDIR', () => {
    expect(
      remoteShellCommand(
        { path: '/usr/bin/zsh', kind: 'zsh', zdotdir: "/home/o'hara/.config/zsh" },
        '/home/u/.cache/muxus',
      ),
    ).toBe(
      "export MUXUS_USER_ZDOTDIR='/home/o'\\''hara/.config/zsh'; " +
        "export ZDOTDIR='/home/u/.cache/muxus/zsh'; exec '/usr/bin/zsh' -l",
    );
  });

  it('starts interactive bash through its cached init file', () => {
    expect(
      remoteShellCommand(
        { path: '/bin/bash', kind: 'bash' },
        '/home/u/.cache/muxus',
      ),
    ).toBe(
      "exec '/bin/bash' --noprofile --rcfile '/home/u/.cache/muxus/bash-init.bash' -i",
    );
  });
});
