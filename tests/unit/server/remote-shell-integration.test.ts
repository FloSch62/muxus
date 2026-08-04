import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  openRemoteShell,
  parseShellProbe,
  RemoteShellTransportLostError,
  remoteShellCommand,
} from '../../../server/src/ssh/remote-shell-integration.js';

class StubChannel extends EventEmitter {
  destroy(): this {
    return this;
  }
}

function stubClient(exec: unknown) {
  return Object.assign(new EventEmitter(), { exec }) as never;
}

describe('remote shell integration', () => {
  it('probes, installs, and opens an integrated remote shell', async () => {
    const probeChannel = new StubChannel();
    const terminalChannel = new StubChannel();
    const commands: string[] = [];
    const setupOrder: string[] = [];
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
        setupOrder.push('probe-start');
        callback(undefined, probeChannel);
        setImmediate(() => {
          setupOrder.push('probe-finish');
          probeChannel.emit(
            'data',
            Buffer.from(
              '__MUXUS_SHELL__=/usr/bin/zsh\n' +
                '__MUXUS_ZDOTDIR__=\n' +
                '__MUXUS_HOME__=/home/u\n',
            ),
          );
          probeChannel.emit('close');
        });
      }
    });
    const writes: string[] = [];
    const directory = {
      isDirectory: () => true,
      isFile: () => false,
    };
    const sftp = {
      stat: (
        remotePath: string,
        callback: (error: Error | undefined, value?: typeof directory) => void,
      ) => {
        if (remotePath.endsWith('/.complete')) callback(new Error('not found'));
        else callback(undefined, directory);
      },
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

    const result = await openRemoteShell(
      stubClient(exec),
      async () => {
        setupOrder.push('sftp-start');
        return sftp as never;
      },
      { term: 'xterm-256color', cols: 80, rows: 24 },
    );

    expect(result).toBe(terminalChannel);
    expect(setupOrder.slice(0, 3)).toEqual(['probe-start', 'probe-finish', 'sftp-start']);
    expect(commands[0]).toContain('"${SHELL-}" "${ZDOTDIR-}" "${HOME-}"');
    expect(commands[0]).not.toContain('\\${SHELL-}');
    expect(commands[1]).toMatch(
      /export ZDOTDIR='\/home\/u\/\.cache\/muxus\/shell-integration\/[a-f0-9]{12}\/zsh'/,
    );
    expect(writes).toHaveLength(4);
    expect(writes[0]).toMatch(/\/shell-integration\/[a-f0-9]{12}\/zsh\/\.zshenv$/);
    expect(writes[1]).toMatch(/\/shell-integration\/[a-f0-9]{12}\/zsh\/\.zprofile$/);
    expect(writes[2]).toMatch(/\/shell-integration\/[a-f0-9]{12}\/zsh\/\.zshrc$/);
    expect(writes[3]).toMatch(/\/shell-integration\/[a-f0-9]{12}\/\.complete$/);
  });

  it('reuses a completed content-addressed install without remote writes', async () => {
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
        return;
      }
      callback(undefined, probeChannel);
      setImmediate(() => {
        probeChannel.emit(
          'data',
          Buffer.from(
            '__MUXUS_SHELL__=/bin/bash\n' +
              '__MUXUS_ZDOTDIR__=\n' +
              '__MUXUS_HOME__=/home/u\n',
          ),
        );
        probeChannel.emit('close');
      });
    });
    const complete = { isFile: () => true };
    const sftp = {
      stat: vi.fn(
        (
          _remotePath: string,
          callback: (error: Error | undefined, value: typeof complete) => void,
        ) => callback(undefined, complete),
      ),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    };

    const result = await openRemoteShell(
      stubClient(exec),
      async () => sftp as never,
      { term: 'xterm-256color', cols: 80, rows: 24 },
    );

    expect(result).toBe(terminalChannel);
    expect(sftp.stat).toHaveBeenCalledOnce();
    expect(sftp.mkdir).not.toHaveBeenCalled();
    expect(sftp.writeFile).not.toHaveBeenCalled();
    expect(commands[1]).toMatch(
      /--rcfile '\/home\/u\/\.cache\/muxus\/shell-integration\/[a-f0-9]{12}\/bash-init\.bash'/,
    );
  });

  it('does not request SFTP when the remote is not a supported Unix shell', async () => {
    const probeChannel = new StubChannel();
    const plainChannel = new StubChannel();
    const getSftp = vi.fn();
    const exec = vi.fn(
      (
        _command: string,
        callback: (error: Error | undefined, channel: StubChannel) => void,
      ) => {
        callback(undefined, probeChannel);
        setImmediate(() => {
          probeChannel.emit('data', Buffer.from('console appliance\n'));
          probeChannel.emit('close');
        });
      },
    );

    const shell = vi.fn(
      (
        _pty: unknown,
        _options: unknown,
        callback: (error: Error | undefined, channel: StubChannel) => void,
      ) => callback(undefined, plainChannel),
    );
    const result = await openRemoteShell(
      Object.assign(stubClient(exec), { shell }),
      getSftp,
      { term: 'xterm-256color', cols: 80, rows: 24 },
    );

    expect(result).toBe(plainChannel);
    expect(getSftp).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();
  });

  it('surfaces a transport lost during the optional shell probe', async () => {
    const client = new EventEmitter() as EventEmitter & {
      exec: (
        command: string,
        callback: (error: Error | undefined, channel: StubChannel) => void,
      ) => void;
    };
    const probeChannel = new StubChannel();
    client.exec = (_command, callback) => {
      callback(undefined, probeChannel);
      setImmediate(() => {
        client.emit('error', new Error('remote protocol disconnect'));
        probeChannel.emit('close');
      });
    };

    await expect(
      openRemoteShell(
        client as never,
        vi.fn(),
        { term: 'xterm-256color', cols: 80, rows: 24 },
      ),
    ).rejects.toBeInstanceOf(RemoteShellTransportLostError);
  });

  it('keeps watching for transport loss while the plain fallback opens', async () => {
    const client = new EventEmitter() as EventEmitter & {
      exec: (
        command: string,
        callback: (error: Error | undefined, channel: StubChannel) => void,
      ) => void;
      shell: (
        pty: unknown,
        options: unknown,
        callback: (error: Error | undefined, channel?: StubChannel) => void,
      ) => void;
    };
    const probeChannel = new StubChannel();
    client.exec = (_command, callback) => {
      callback(undefined, probeChannel);
      setImmediate(() => probeChannel.emit('close'));
    };
    client.shell = (_pty, _options, callback) => {
      expect(client.listenerCount('end')).toBe(1);
      setImmediate(() => {
        client.emit('end');
        callback(new Error('Not connected'));
      });
    };

    await expect(
      openRemoteShell(
        client as never,
        vi.fn(),
        { term: 'xterm-256color', cols: 80, rows: 24 },
      ),
    ).rejects.toBeInstanceOf(RemoteShellTransportLostError);
  });

  it('detects supported shells among startup output', () => {
    expect(
      parseShellProbe(
        'banner\n' +
          '__MUXUS_SHELL__=/usr/bin/zsh\n' +
          '__MUXUS_ZDOTDIR__=/home/u/.config/zsh\n' +
          '__MUXUS_HOME__=/home/u\n',
      ),
    ).toEqual({
      path: '/usr/bin/zsh',
      kind: 'zsh',
      home: '/home/u',
      zdotdir: '/home/u/.config/zsh',
    });
    expect(
      parseShellProbe(
        '__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n',
      ),
    ).toEqual({
      path: '/bin/bash',
      kind: 'bash',
      home: '/home/u',
    });
  });

  it('rejects unsupported and missing shells', () => {
    expect(
      parseShellProbe(
        '__MUXUS_SHELL__=/usr/bin/fish\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n',
      ),
    ).toBeUndefined();
    expect(
      parseShellProbe('__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n'),
    ).toBeUndefined();
    expect(parseShellProbe('')).toBeUndefined();
  });

  it('starts zsh through the cached shim and preserves a custom ZDOTDIR', () => {
    expect(
      remoteShellCommand(
        {
          path: '/usr/bin/zsh',
          kind: 'zsh',
          home: '/home/u',
          zdotdir: "/home/o'hara/.config/zsh",
        },
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
        { path: '/bin/bash', kind: 'bash', home: '/home/u' },
        '/home/u/.cache/muxus',
      ),
    ).toBe(
      "exec '/bin/bash' --noprofile --rcfile '/home/u/.cache/muxus/bash-init.bash' -i",
    );
  });
});
