import { describe, expect, it } from 'vitest';
import {
  environmentArgv,
  environmentCommandLine,
  environmentTitle,
  isValidEnvironmentTarget,
  shellQuote,
  type EnvironmentTarget,
} from '@muxus/shared';
import { localProfileSchema, sessionProfileSchema, sshProfileSchema } from '@muxus/shared/ws-protocol';

describe('environmentArgv', () => {
  it('enters a container with the best shell it has', () => {
    expect(environmentArgv({ kind: 'container', runtime: 'docker', container: 'web-1' })).toEqual([
      'docker',
      'exec',
      '-it',
      '-e',
      'TERM=xterm-256color',
      'web-1',
      'sh',
      '-c',
      'if command -v bash >/dev/null 2>&1; then exec bash; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi',
    ]);
    expect(
      environmentArgv({ kind: 'container', runtime: 'podman', container: 'db', shell: 'bash' }).slice(-2),
    ).toEqual(['db', 'bash']);
  });

  it('follows container and pod logs', () => {
    expect(environmentArgv({ kind: 'container-logs', runtime: 'docker', container: 'web' })).toEqual([
      'docker',
      'logs',
      '--follow',
      '--tail',
      '1000',
      'web',
    ]);
    expect(
      environmentArgv({
        kind: 'pod-logs',
        context: 'kind-dev',
        namespace: 'default',
        pod: 'worker-5d4b8-zq1rt',
        container: 'worker',
        previous: true,
      }),
    ).toEqual([
      'kubectl',
      '--context=kind-dev',
      '--namespace=default',
      'logs',
      'worker-5d4b8-zq1rt',
      '--container=worker',
      '--tail=1000',
      '--previous',
    ]);
  });

  it('passes kube contexts as one option, so a free-form name cannot split', () => {
    const argv = environmentArgv({
      kind: 'pod',
      context: 'arn:aws:eks:eu-central-1:1234:cluster/prod one',
      namespace: 'kube-system',
      pod: 'coredns-abc',
    });
    expect(argv.slice(0, 7)).toEqual([
      'kubectl',
      '--context=arn:aws:eks:eu-central-1:1234:cluster/prod one',
      '--namespace=kube-system',
      'exec',
      '-it',
      'coredns-abc',
      '--',
    ]);
  });

  it('enters Proxmox guests and libvirt consoles', () => {
    expect(environmentArgv({ kind: 'proxmox-lxc', vmid: 201 })).toEqual(['pct', 'enter', '201']);
    expect(environmentArgv({ kind: 'proxmox-serial', vmid: 101 })).toEqual(['qm', 'terminal', '101']);
    expect(environmentArgv({ kind: 'libvirt-console', domain: 'runner', uri: 'qemu:///system' })).toEqual([
      'virsh',
      '-c',
      'qemu:///system',
      'console',
      '--force',
      'runner',
    ]);
  });

  it('refuses names that could read as options or carry shell syntax', () => {
    const bad: EnvironmentTarget[] = [
      { kind: 'container', runtime: 'docker', container: '-v' },
      { kind: 'container', runtime: 'docker', container: 'web;rm -rf /' },
      { kind: 'pod', namespace: 'default', pod: 'Pod' },
      { kind: 'pod', namespace: 'default', pod: 'web', context: '-x' },
      { kind: 'proxmox-lxc', vmid: 5 },
      { kind: 'libvirt-console', domain: '--help' },
      { kind: 'libvirt-console', domain: 'vm', uri: 'qemu+ssh://evil/system' as 'qemu:///system' },
    ];
    for (const target of bad) {
      expect(isValidEnvironmentTarget(target)).toBe(false);
      expect(() => environmentArgv(target)).toThrow();
    }
  });
});

describe('shellQuote', () => {
  it('leaves plain words alone and quotes the rest', () => {
    expect(shellQuote('web-1')).toBe('web-1');
    expect(shellQuote('--context=kind-dev')).toBe('--context=kind-dev');
    expect(shellQuote('two words')).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
  });

  it('builds the command line an SSH session runs', () => {
    expect(environmentCommandLine({ kind: 'libvirt-console', domain: 'my vm' })).toBe("virsh console --force 'my vm'");
    expect(environmentCommandLine({ kind: 'container', runtime: 'docker', container: 'web', shell: 'sh' })).toBe(
      'docker exec -it -e TERM=xterm-256color web sh',
    );
  });
});

describe('environmentTitle', () => {
  it('names tabs after what they enter', () => {
    expect(environmentTitle({ kind: 'container', runtime: 'docker', container: 'nginx' })).toBe('nginx');
    expect(environmentTitle({ kind: 'pod-logs', namespace: 'default', pod: 'api' })).toBe('logs · api');
    expect(environmentTitle({ kind: 'proxmox-serial', vmid: 101 })).toBe('VM 101 · serial');
  });
});

describe('profile schemas', () => {
  it('accepts an environment on local and SSH sessions', () => {
    const local = localProfileSchema.parse({
      kind: 'local',
      environment: { kind: 'container', runtime: 'docker', container: 'web' },
    });
    expect(local.environment).toEqual({ kind: 'container', runtime: 'docker', container: 'web' });
    const ssh = sshProfileSchema.parse({
      kind: 'ssh',
      target: 'build-01',
      environment: { kind: 'pod', namespace: 'default', pod: 'api-1' },
    });
    expect(ssh.environment?.kind).toBe('pod');
  });

  it('rejects targets the server could not run safely', () => {
    for (const environment of [
      { kind: 'container', runtime: 'docker', container: '$(reboot)' },
      { kind: 'container', runtime: 'nerdctl', container: 'web' },
      { kind: 'pod', namespace: 'Default', pod: 'api' },
      { kind: 'proxmox-serial', vmid: 1.5 },
      { kind: 'shell', command: 'id' },
    ]) {
      expect(
        sessionProfileSchema.safeParse({ kind: 'ssh', target: 'build-01', environment }).success,
      ).toBe(false);
    }
  });
});
