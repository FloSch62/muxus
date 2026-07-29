import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentSocket } from '../../../server/src/ssh/key-scan.js';

describe('resolveAgentSocket', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('falls back to the environment default when no IdentityAgent is set', () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/run/user/1000/ssh-agent.sock');
    expect(resolveAgentSocket(undefined)).toBe('/run/user/1000/ssh-agent.sock');
  });

  it('disables the agent for IdentityAgent none', () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/run/user/1000/ssh-agent.sock');
    expect(resolveAgentSocket('none')).toBeUndefined();
  });

  it('uses a configured socket path (1Password-style)', () => {
    expect(resolveAgentSocket('/home/user/.1password/agent.sock')).toBe('/home/user/.1password/agent.sock');
    expect(resolveAgentSocket('~/.1password/agent.sock')).toBe(
      path.join(os.homedir(), '.1password', 'agent.sock'),
    );
  });

  it('dereferences $VAR, ${VAR}, and the literal SSH_AUTH_SOCK', () => {
    vi.stubEnv('CUSTOM_SOCK', '/tmp/custom.sock');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/default.sock');
    expect(resolveAgentSocket('$CUSTOM_SOCK')).toBe('/tmp/custom.sock');
    expect(resolveAgentSocket('${CUSTOM_SOCK}')).toBe('/tmp/custom.sock');
    expect(resolveAgentSocket('SSH_AUTH_SOCK')).toBe('/tmp/default.sock');
    expect(resolveAgentSocket('$MISSING_VAR')).toBeUndefined();
    expect(resolveAgentSocket('${MISSING_VAR}')).toBeUndefined();
  });
});
