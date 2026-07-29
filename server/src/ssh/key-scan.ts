import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ssh2 is CommonJS; `utils`/`createAgent` are attached dynamically and escape
// Node's named-export detection, so they must come off the default export.
import ssh2, { type BaseAgent, type ParsedKey } from 'ssh2';

const { createAgent, utils } = ssh2;
import type { SshAgentKey, SshKeyInfo, SshKeysResponse } from '@muxus/shared';
import { fingerprintSha256 } from './known-hosts.js';

/**
 * Discover the user's SSH identities for the host editor's key picker: the
 * private keys sitting in ~/.ssh (type/comment from the .pub sibling,
 * encrypted-or-not from a parse probe) and what the agent currently holds,
 * cross-referenced by fingerprint so the UI can badge keys as loaded.
 */

const PRIVATE_KEY_HEADERS = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
  'PuTTY-User-Key-File-',
];

/** Files in ~/.ssh that are definitely not private keys. */
const SKIP_FILE_RE = /^(config|known_hosts|authorized_keys)|\.(pub|old|bak|tmp)$|muxus/i;

const MAX_KEY_FILE_BYTES = 1024 * 1024;

export function agentSocket(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

/**
 * The agent socket for one host: the IdentityAgent override when set
 * (`none`, `$VAR`/`${VAR}`, the literal `SSH_AUTH_SOCK`, or a path —
 * 1Password and friends), otherwise the environment default.
 */
export function resolveAgentSocket(identityAgent?: string): string | undefined {
  if (identityAgent === undefined) return agentSocket();
  if (identityAgent.toLowerCase() === 'none') return undefined;
  if (identityAgent === 'SSH_AUTH_SOCK') return process.env.SSH_AUTH_SOCK || undefined;
  if (identityAgent.startsWith('$')) {
    const braced = /^\$\{([^{}]+)\}$/.exec(identityAgent);
    const name = braced?.[1] ?? identityAgent.slice(1);
    return process.env[name] || undefined;
  }
  return identityAgent.replace(/^~(?=$|[\\/])/, os.homedir());
}

export async function listAgentKeys(sock = agentSocket()): Promise<SshAgentKey[]> {
  if (!sock) return [];
  return new Promise((resolve) => {
    try {
      (createAgent(sock) as BaseAgent<ParsedKey>).getIdentities((err, keys) => {
        if (err || !keys) {
          resolve([]);
          return;
        }
        // Real agents hand back ParsedKey objects; skip anything else.
        const parsed = keys.filter((k): k is ParsedKey => !!k && typeof k === 'object' && 'getPublicSSH' in k);
        resolve(
          parsed.map((k) => ({
            type: k.type,
            comment: k.comment || undefined,
            fingerprint: fingerprintSha256(k.getPublicSSH()),
          })),
        );
      });
    } catch {
      resolve([]);
    }
  });
}

export async function listSshKeys(
  {
    dir = path.join(os.homedir(), '.ssh'),
    identityAgent,
  }: {
    dir?: string;
    identityAgent?: string;
  } = {},
): Promise<SshKeysResponse> {
  const sock = resolveAgentSocket(identityAgent);
  const agentKeys = sock ? await listAgentKeys(sock) : [];
  const agentPrints = new Set(agentKeys.map((k) => k.fingerprint));
  const keys: SshKeyInfo[] = [];

  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No ~/.ssh yet — perfectly fine.
  }

  for (const name of names.sort()) {
    if (SKIP_FILE_RE.test(name)) continue;
    const filePath = path.join(dir, name);
    let content: Buffer;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) continue;
      content = fs.readFileSync(filePath);
    } catch {
      continue;
    }
    const head = content.subarray(0, 64).toString('latin1');
    if (!PRIVATE_KEY_HEADERS.some((h) => head.startsWith(h))) continue;

    const probe = utils.parseKey(content);
    const encrypted = probe instanceof Error;
    if (probe instanceof Error && !/passphrase|encrypted/i.test(probe.message)) continue; // not actually a usable key
    const parsed = probe instanceof Error ? undefined : probe;

    let type = parsed?.type as string | undefined;
    let comment = parsed?.comment || undefined;
    let fingerprint = parsed ? fingerprintSha256(parsed.getPublicSSH()) : undefined;

    // The .pub sibling names the algorithm and comment even for encrypted keys.
    try {
      const pub = fs.readFileSync(`${filePath}.pub`, 'utf8').trim().split(/\s+/);
      if (pub[0] && pub[1]) {
        type ??= pub[0];
        comment ??= pub.slice(2).join(' ') || undefined;
        fingerprint ??= fingerprintSha256(Buffer.from(pub[1], 'base64'));
      }
    } catch {
      // No .pub — fine.
    }

    keys.push({
      path: filePath,
      name,
      type,
      comment,
      encrypted,
      inAgent: !!fingerprint && agentPrints.has(fingerprint),
    });
  }

  return { agentAvailable: !!sock && (process.platform !== 'win32' || agentKeys.length > 0), agentKeys, keys };
}
