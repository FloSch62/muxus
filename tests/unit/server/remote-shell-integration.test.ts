import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SshError } from '../../../server/src/ssh/engine.js';
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

/** The part of a transport that reports its own end, which a test brings about with `lose`. */
class StubTransport {
  closed = false;
  private readonly closeListeners = new Set<(reason?: string) => void>();

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  closeListenerCount(): number {
    return this.closeListeners.size;
  }

  /** As the engine ends a connection: closed first, then the listeners hear of it. */
  lose(reason?: string): void {
    this.closed = true;
    for (const listener of this.closeListeners) listener(reason);
  }
}

function stubTransport(exec: unknown) {
  return Object.assign(new StubTransport(), { exec }) as never;
}

describe('remote shell integration', () => {
  it('probes, installs, and opens an integrated remote shell', async () => {
    const probeChannel = new StubChannel();
    const terminalChannel = new StubChannel();
    const commands: string[] = [];
    const setupOrder: string[] = [];
    // The probe runs without session options; only the terminal gets them.
    const exec = vi.fn(async (command: string, options?: unknown) => {
      commands.push(command);
      if (options) return terminalChannel;
      setupOrder.push('probe-start');
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
      return probeChannel;
    });
    const writes: string[] = [];
    const directory = {
      isDirectory: () => true,
      isFile: () => false,
    };
    const sftp = {
      stat: async (remotePath: string) => {
        if (remotePath.endsWith('/.complete')) throw new Error('not found');
        return directory;
      },
      mkdir: async () => undefined,
      writeFile: async (remotePath: string) => {
        writes.push(remotePath);
      },
    };

    const result = await openRemoteShell(
      stubTransport(exec),
      async () => {
        setupOrder.push('sftp-start');
        return sftp as never;
      },
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
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
    const exec = vi.fn(async (command: string, options?: unknown) => {
      commands.push(command);
      if (options) return terminalChannel;
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
      return probeChannel;
    });
    const complete = { isFile: () => true };
    const sftp = {
      stat: vi.fn(async (_remotePath: string) => complete),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    };

    const result = await openRemoteShell(
      stubTransport(exec),
      async () => sftp as never,
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
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
    const exec = vi.fn(async (_command: string) => {
      setImmediate(() => {
        probeChannel.emit('data', Buffer.from('console appliance\n'));
        probeChannel.emit('close');
      });
      return probeChannel;
    });

    const shell = vi.fn(async (_options: unknown) => plainChannel);
    const probe = { ranCommand: false, execRefused: false };
    const result = await openRemoteShell(
      Object.assign(stubTransport(exec), { shell }),
      getSftp,
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
      undefined,
      probe,
    );

    expect(result).toBe(plainChannel);
    expect(getSftp).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();
    expect(probe).toEqual({ ranCommand: false, execRefused: false });
  });

  it('records a server that ran the probe, even in a shell it does not integrate', async () => {
    const probe = { ranCommand: false, execRefused: false };
    const exec = async (_command: string) => {
      const probeChannel = new StubChannel();
      setImmediate(() => {
        probeChannel.emit('data', Buffer.from('__MUXUS_SHELL__=/usr/bin/fish\n__MUXUS_HOME__=/home/u\n'));
        probeChannel.emit('close');
      });
      return probeChannel;
    };
    await openRemoteShell(
      Object.assign(stubTransport(exec), {
        shell: async (_options: unknown) => new StubChannel(),
      }),
      vi.fn(),
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
      undefined,
      probe,
    );
    expect(probe).toEqual({ ranCommand: true, execRefused: false });
  });

  it('probes a transport that refused exec only once', async () => {
    // Nokia SR OS keeps a refused exec channel's slot until the connection
    // closes; a probe per shell would use up the few slots it allows.
    const probe = { ranCommand: false, execRefused: false };
    const exec = vi.fn(async (_command: string) => {
      throw new SshError('Unable to exec', 'EXEC_REFUSED');
    });
    const shell = vi.fn(async (_options: unknown) => new StubChannel());
    const transport = Object.assign(stubTransport(exec), { shell });
    const options = { pty: { term: 'xterm-256color', cols: 80, rows: 24 } };

    await openRemoteShell(transport, vi.fn(), options, undefined, probe);
    expect(probe).toEqual({ ranCommand: false, execRefused: true });
    await openRemoteShell(transport, vi.fn(), options, undefined, probe);

    expect(exec).toHaveBeenCalledOnce();
    expect(shell).toHaveBeenCalledTimes(2);
  });

  it('keeps probing after a channel open failure, such as a full MaxSessions', async () => {
    const probe = { ranCommand: false, execRefused: false };
    const exec = vi.fn(async (_command: string) => {
      throw new SshError('Channel open failure: administratively prohibited', 'CHANNEL_OPEN_FAILED', 1);
    });
    await openRemoteShell(
      Object.assign(stubTransport(exec), {
        shell: async (_options: unknown) => new StubChannel(),
      }),
      vi.fn(),
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
      undefined,
      probe,
    );
    expect(probe.execRefused).toBe(false);
  });

  it('surfaces a transport lost during the optional shell probe', async () => {
    const transport = new StubTransport() as StubTransport & {
      exec: (command: string) => Promise<StubChannel>;
    };
    const probeChannel = new StubChannel();
    transport.exec = async () => {
      setImmediate(() => {
        transport.lose('remote protocol disconnect');
        probeChannel.emit('close');
      });
      return probeChannel;
    };

    await expect(
      openRemoteShell(
        transport as never,
        vi.fn(),
        { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
      ),
    ).rejects.toBeInstanceOf(RemoteShellTransportLostError);
  });

  it('keeps watching for transport loss while the plain fallback opens', async () => {
    const transport = new StubTransport() as StubTransport & {
      exec: (command: string) => Promise<StubChannel>;
      shell: (options: unknown) => Promise<StubChannel>;
    };
    const probeChannel = new StubChannel();
    transport.exec = async () => {
      setImmediate(() => probeChannel.emit('close'));
      return probeChannel;
    };
    transport.shell = () => {
      expect(transport.closeListenerCount()).toBe(1);
      return new Promise((_resolve, reject) => {
        setImmediate(() => {
          transport.lose();
          reject(new SshError('Not connected', 'DISCONNECTED'));
        });
      });
    };

    await expect(
      openRemoteShell(
        transport as never,
        vi.fn(),
        { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
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

  it('hands a reconnect directory to the startup files as quoted data', () => {
    const cwd = "/srv/team's $(project)";
    expect(
      remoteShellCommand(
        { path: '/bin/bash', kind: 'bash', home: '/home/u' },
        '/home/u/.cache/muxus',
        cwd,
      ),
    ).toBe(
      "export MUXUS_RESTORE_CWD='/srv/team'\\''s $(project)'; " +
        "exec '/bin/bash' --noprofile --rcfile '/home/u/.cache/muxus/bash-init.bash' -i",
    );
    expect(
      remoteShellCommand(
        { path: '/usr/bin/zsh', kind: 'zsh', home: '/home/u' },
        '/home/u/.cache/muxus',
        cwd,
      ),
    ).toBe(
      "export MUXUS_RESTORE_CWD='/srv/team'\\''s $(project)'; unset MUXUS_USER_ZDOTDIR; " +
        "export ZDOTDIR='/home/u/.cache/muxus/zsh'; exec '/usr/bin/zsh' -l",
    );
  });

  it('only restores absolute Unix directories', () => {
    const bash = { path: '/bin/bash', kind: 'bash', home: '/home/u' } as const;
    const plain = remoteShellCommand(bash, '/home/u/.cache/muxus');
    expect(remoteShellCommand(bash, '/home/u/.cache/muxus', 'relative/path')).toBe(plain);
    expect(remoteShellCommand(bash, '/home/u/.cache/muxus', 'C:\\work')).toBe(plain);
    expect(remoteShellCommand(bash, '/home/u/.cache/muxus', '/srv/bad\0path')).toBe(plain);
  });

  it('changes into the reconnect directory at the end of shell startup', async () => {
    const contents = new Map<string, string>();
    const probeChannel = new StubChannel();
    const exec = vi.fn(async (_command: string, options?: unknown) => {
      if (options) return new StubChannel();
      setImmediate(() => {
        probeChannel.emit('data', Buffer.from('__MUXUS_SHELL__=/usr/bin/zsh\n__MUXUS_HOME__=/home/u\n'));
        probeChannel.emit('close');
      });
      return probeChannel;
    });
    const sftp = {
      stat: async (remotePath: string) => {
        if (remotePath.endsWith('/.complete')) throw new Error('not found');
        return { isDirectory: () => true, isFile: () => false };
      },
      mkdir: async () => undefined,
      writeFile: async (remotePath: string, content: string) => {
        contents.set(remotePath, content);
      },
    };

    await openRemoteShell(
      stubTransport(exec),
      async () => sftp as never,
      { pty: { term: 'xterm-256color', cols: 80, rows: 24 } },
      '/srv/project',
    );

    const zshrc = [...contents].find(([remotePath]) => remotePath.endsWith('/zsh/.zshrc'))?.[1];
    expect(exec.mock.calls.at(-1)?.[0]).toMatch(/^export MUXUS_RESTORE_CWD='\/srv\/project'; /);
    // After the user's .zshrc and the integration hooks, so neither undoes it.
    expect(zshrc?.indexOf('builtin cd -- "$MUXUS_RESTORE_CWD"')).toBeGreaterThan(
      zshrc!.indexOf('add-zsh-hook precmd'),
    );
    expect(zshrc?.trimEnd().endsWith('builtin unset MUXUS_RESTORE_CWD')).toBe(true);
  });
});
