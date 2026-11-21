import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, inject, vi } from 'vitest';
import type { SshProfile } from '@muxus/shared/ws-protocol';
import {
  SshConnectionManager,
  type ConnectIo,
  type HostKeyChallenge,
} from '../../server/src/ssh/connection-manager.js';
import type { SshChannel } from '../../server/src/ssh/engine.js';
import { KnownHostsStore } from '../../server/src/ssh/known-hosts.js';
import { loadConfigDocument } from '../../server/src/ssh/ssh-config.js';
import type { LocalX11 } from '../../server/src/x11/local-x11.js';

export const server = inject('openssh');

/** A private key or certificate the container made. */
export const fixture = (name: string) => path.join(server.fixtures, name);

/** Run a command in the container, as root. */
export function inContainer(...command: string[]): string {
  return execFileSync('docker', ['exec', server.container, ...command], { encoding: 'utf8' });
}

/** What a login asked the user, and what it said along the way. */
export interface RecordedIo {
  io: ConnectIo;
  statuses: string[];
  prompts: Array<{ host?: string; prompts: string[]; purpose?: string }>;
  hostKeys: HostKeyChallenge[];
}

/**
 * Answers prompts from `answers` in order, each entry answering one prompt
 * dialog. A dialog nothing is left for is dismissed, which cancels the login.
 */
export function recordingIo(answers: string[][] = [], acceptHostKey = true): RecordedIo {
  const recorded: RecordedIo = {
    statuses: [],
    prompts: [],
    hostKeys: [],
    io: {
      status: (message) => recorded.statuses.push(message),
      prompt: (info) => {
        recorded.prompts.push({
          host: info.host,
          prompts: info.prompts.map((prompt) => prompt.prompt),
          purpose: info.purpose,
        });
        const next = answers.shift();
        return next ? Promise.resolve({ answers: next }) : Promise.reject(new Error('dismissed'));
      },
      hostKey: (challenge) => {
        recorded.hostKeys.push(challenge);
        return Promise.resolve(acceptHostKey);
      },
    },
  };
  return recorded;
}

/**
 * A home directory of its own for the file's tests: no key, agent or
 * known_hosts of the person running them takes part.
 */
export function useScratchHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'muxus-openssh-home-'));
  const saved = { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  const managers: SshConnectionManager[] = [];
  let counter = 0;

  beforeAll(() => {
    process.env.HOME = home;
    delete process.env.SSH_AUTH_SOCK;
  });
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.closeAll();
  });
  afterAll(() => {
    process.env.HOME = saved.HOME;
    if (saved.SSH_AUTH_SOCK === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = saved.SSH_AUTH_SOCK;
    rmSync(home, { recursive: true, force: true });
  });

  return {
    home,
    /**
     * A connection manager reading an ssh config of its own. `hosts` maps an
     * alias to its option lines; every alias reaches the container unless it
     * says otherwise, and starts with an empty known_hosts.
     */
    manager(
      hosts: Record<string, string[]>,
      options: { knownHosts?: string; x11?: LocalX11 } = {},
    ): SshConnectionManager {
      const id = counter++;
      const config = path.join(home, `ssh_config-${id}`);
      const reaches = (lines: string[], keyword: string) =>
        lines.some((line) => line.toLowerCase().startsWith(`${keyword.toLowerCase()} `));
      writeFileSync(
        config,
        Object.entries(hosts)
          .map(([alias, lines]) =>
            [
              `Host ${alias}`,
              ...(reaches(lines, 'HostName') ? [] : ['  HostName 127.0.0.1']),
              ...(reaches(lines, 'Port') ? [] : [`  Port ${server.port}`]),
              ...lines.map((line) => `  ${line}`),
            ].join('\n'),
          )
          .join('\n\n') + '\n',
      );
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const manager = new SshConnectionManager(log as never, {
        knownHosts: new KnownHostsStore(
          options.knownHosts ?? path.join(home, `known_hosts-${id}`),
          path.join(home, 'no-global-known-hosts'),
        ),
        loadConfig: () => loadConfigDocument(config),
        jumpHopIdleMs: 50,
        ...(options.x11 ? { x11: options.x11 } : {}),
      });
      managers.push(manager);
      return manager;
    },
  };
}

export function ssh(target: string, extra: Partial<SshProfile> = {}): SshProfile {
  return { kind: 'ssh', target, ...extra } as SshProfile;
}

/** Everything a command prints, and how it ended. */
export function finished(
  channel: SshChannel,
): Promise<{ stdout: string; stderr: string; code: number | null; signal?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let exit: { code: number | null; signal?: string } = { code: null };
    channel.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    channel.once('exit', (code: number | null, signal?: string) => (exit = { code, signal }));
    channel.once('error', reject);
    channel.once('close', () => resolve({ stdout, stderr, ...exit }));
  });
}

/** Collects a terminal's output; `waitFor` settles once `text` has appeared. */
export function terminalOutput(channel: SshChannel) {
  let seen = '';
  channel.on('data', (chunk: Buffer) => (seen += chunk.toString()));
  return {
    text: () => seen,
    waitFor: (text: string | RegExp) =>
      vi.waitFor(
        () => {
          const found = typeof text === 'string' ? seen.includes(text) : text.test(seen);
          if (!found) throw new Error(`no ${String(text)} in ${JSON.stringify(seen.slice(-400))}`);
        },
        { timeout: 15_000, interval: 25 },
      ),
  };
}
