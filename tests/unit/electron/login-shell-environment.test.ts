import { describe, expect, it, vi } from 'vitest';
import { importLoginShellEnvironment } from '../../../electron/src/login-shell-environment.js';

describe('login shell environment', () => {
  it('imports PATH and SSH_AUTH_SOCK for a Finder-launched macOS app', () => {
    const environment = {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/default-agent',
    };

    importLoginShellEnvironment(
      'darwin',
      environment,
      () => ({
        PATH: '/opt/homebrew/bin:/usr/bin',
        SSH_AUTH_SOCK: '/Users/alice/Library/Group Containers/1password/agent.sock',
      }),
    );

    expect(environment).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      SSH_AUTH_SOCK: '/Users/alice/Library/Group Containers/1password/agent.sock',
    });
  });

  it('does not replace the launch environment when the shell has no agent socket', () => {
    const environment = {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/default-agent',
    };

    importLoginShellEnvironment(
      'darwin',
      environment,
      () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }),
    );

    expect(environment.SSH_AUTH_SOCK).toBe('/private/tmp/com.apple.launchd/default-agent');
  });

  it('keeps SSH_AUTH_SOCK unchanged on Linux and skips shell startup on Windows', () => {
    const linuxEnvironment = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/user/1000/agent.sock' };
    importLoginShellEnvironment(
      'linux',
      linuxEnvironment,
      () => ({ PATH: '/home/alice/bin:/usr/bin', SSH_AUTH_SOCK: '/tmp/other.sock' }),
    );
    expect(linuxEnvironment).toEqual({
      PATH: '/home/alice/bin:/usr/bin',
      SSH_AUTH_SOCK: '/run/user/1000/agent.sock',
    });

    const readLoginEnvironment = vi.fn(() => ({ PATH: 'ignored' }));
    const windowsEnvironment = { PATH: 'C:\\Windows\\System32' };
    importLoginShellEnvironment('win32', windowsEnvironment, readLoginEnvironment);
    expect(readLoginEnvironment).not.toHaveBeenCalled();
    expect(windowsEnvironment.PATH).toBe('C:\\Windows\\System32');
  });

  it('leaves the current environment intact when shell startup fails', () => {
    const environment = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/current.sock' };
    importLoginShellEnvironment(
      'darwin',
      environment,
      () => {
        throw new Error('shell failed');
      },
    );
    expect(environment).toEqual({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/current.sock' });
  });

  it('reports a failed shell startup to the diagnostics hook', () => {
    const failure = new Error('shell failed');
    const onError = vi.fn();
    importLoginShellEnvironment(
      'darwin',
      { PATH: '/usr/bin' },
      () => {
        throw failure;
      },
      onError,
    );
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
