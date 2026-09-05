import { describe, expect, it, vi } from 'vitest';
import { importLoginShellEnvironment } from '../../../desktop/src/login-shell-environment.js';

describe('login shell environment', async () => {
  it('imports PATH and SSH_AUTH_SOCK for a Finder-launched macOS app', async () => {
    const environment = {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/default-agent',
    };

    await importLoginShellEnvironment(
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

  it('does not replace the launch environment when the shell has no agent socket', async () => {
    const environment = {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/default-agent',
    };

    await importLoginShellEnvironment(
      'darwin',
      environment,
      () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }),
    );

    expect(environment.SSH_AUTH_SOCK).toBe('/private/tmp/com.apple.launchd/default-agent');
  });

  it('keeps SSH_AUTH_SOCK unchanged on Linux and skips shell startup on Windows', async () => {
    const linuxEnvironment = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/user/1000/agent.sock' };
    await importLoginShellEnvironment(
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
    await importLoginShellEnvironment('win32', windowsEnvironment, readLoginEnvironment);
    expect(readLoginEnvironment).not.toHaveBeenCalled();
    expect(windowsEnvironment.PATH).toBe('C:\\Windows\\System32');
  });

  it('leaves the current environment intact when shell startup fails', async () => {
    const environment = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/current.sock' };
    await importLoginShellEnvironment(
      'darwin',
      environment,
      () => {
        throw new Error('shell failed');
      },
    );
    expect(environment).toEqual({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/current.sock' });
  });

  it('reports a failed shell startup to the diagnostics hook', async () => {
    const failure = new Error('shell failed');
    const onError = vi.fn();
    await importLoginShellEnvironment(
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
