import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SshAgentKey, SshKeyInfo, SshKeysResponse } from '@muxus/shared';
import { isEncryptedKeyError, parseSshKey } from './certificates.js';
import type { SshAgent } from './identity.js';
import { fingerprintSha256 } from './known-hosts.js';
import { ResponsiveAgent } from './responsive-agent.js';
import { isSecurityKeyType, readOpenSshKeyFile } from './security-keys.js';

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

export interface AgentKeyProbe {
  available: boolean;
  keys: SshAgentKey[];
}

/** Ask an agent for its identities; `available` is false when it does not answer. */
export async function probeAgentKeys(
  sock: string | undefined,
  agent?: SshAgent,
): Promise<AgentKeyProbe> {
  if (!sock) return { available: false, keys: [] };
  const client =
    agent ??
    new ResponsiveAgent(sock, {
      // Discovery only supplies editor badges; it must never hold the form
      // open waiting for an approval that may not be visible.
      operationTimeoutMs: 2_000,
      waitStatusMs: -1,
    });
  try {
    const identities = await client.identities();
    return {
      available: true,
      keys: identities.map((identity) => ({
        type: identity.type,
        comment: identity.comment || undefined,
        fingerprint: fingerprintSha256(identity.blob),
      })),
    };
  } catch {
    return { available: false, keys: [] };
  }
}

export async function listAgentKeys(
  sock = agentSocket(),
  agent?: SshAgent,
): Promise<SshAgentKey[]> {
  return (await probeAgentKeys(sock, agent)).keys;
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
  const agent = await probeAgentKeys(sock);
  const agentKeys = agent.keys;
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

    // A security key file holds only a key handle; its header names the key.
    const header = readOpenSshKeyFile(content);
    const securityKey = header && isSecurityKeyType(header.type) ? header : undefined;
    const probe = securityKey ? undefined : parseSshKey(content);
    const encrypted = securityKey ? securityKey.encrypted : probe instanceof Error;
    if (probe instanceof Error && !isEncryptedKeyError(probe)) continue; // not actually a usable key
    const parsed = probe instanceof Error ? undefined : probe;

    let type = (parsed?.keyType ?? securityKey?.type) as string | undefined;
    let comment = parsed?.comment || undefined;
    let fingerprint = parsed
      ? fingerprintSha256(parsed.publicBlob())
      : securityKey
        ? fingerprintSha256(securityKey.publicBlob)
        : undefined;

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

  return { agentAvailable: agent.available, agentKeys, keys };
}
