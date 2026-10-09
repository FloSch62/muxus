import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2, { BaseAgent, type ParsedKey, type SigningRequestOptions } from 'ssh2';
import { ResponsiveAgent, type ResponsiveAgentOptions } from './responsive-agent.js';
import {
  classifyAskpassPrompt,
  SecurityKeyError,
  securityKeyTypeName,
  type SecurityKeyQuestion,
} from './security-keys.js';

type SignCallback = (err?: Error | null, signature?: Buffer) => void;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// OpenSSH runs $SSH_ASKPASS with the prompt as its argument and reads the
// answer from stdout. This relays it to the Muxus prompt over a socket in
// the private directory. A touch notification (SSH_ASKPASS_PROMPT=none)
// needs no answer: Muxus shows its own.
const ASKPASS_RELAY = `'use strict';
const net = require('node:net');
if (process.env.SSH_ASKPASS_PROMPT === 'none') process.exit(0);
let reply = '';
const socket = net.connect(process.argv[2]);
socket.setEncoding('utf8');
socket.on('connect', () => {
  socket.end(JSON.stringify({ prompt: process.argv[3] || '' }));
});
socket.on('data', (chunk) => { reply += chunk; });
socket.on('error', () => process.exit(1));
socket.on('close', () => {
  let answer;
  try { answer = JSON.parse(reply).answer; } catch {}
  if (typeof answer !== 'string') process.exit(1);
  process.stdout.write(answer + '\\n');
});
`;

const MAX_PASSPHRASE_PROMPTS = 3;

/** Leaves room for the socket names within macOS's 104-byte socket path limit. */
const MAX_SOCKET_DIR_LENGTH = 90;

/** The agent's recent log, kept to explain a failed signature. */
const MAX_AGENT_LOG = 4096;

/** A per-user runtime directory when there is one, else the temp directory. */
function privateDirectory(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  let root = runtime && path.isAbsolute(runtime) && fs.existsSync(runtime) ? runtime : os.tmpdir();
  if (path.join(root, 'muxus-sk-XXXXXX').length > MAX_SOCKET_DIR_LENGTH) root = '/tmp';
  return fs.mkdtempSync(path.join(root, 'muxus-sk-'));
}

function missingTool(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** An OpenSSH tool's complaint without its decorative banner lines. */
function processReason(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('@'))
    .join(' ');
}

/** What ssh-agent logged about a failed signature, in the user's terms. */
export function agentFailureReason(log: string): string | undefined {
  if (/internal security key support not enabled/i.test(log)) {
    return 'this OpenSSH has no built-in security key support: set SecurityKeyProvider to a FIDO middleware library, or use an OpenSSH built with FIDO support';
  }
  if (/device not found/i.test(log)) return 'no security key is plugged in';
  if (/incorrect passphrase|wrong passphrase/i.test(log)) return 'the PIN was not accepted';
  return undefined;
}

export interface SecurityKeyFileOptions {
  file: string;
  /** The key's public half, from the key file's header. */
  publicKey: ParsedKey;
  /** What to offer the server instead, such as a certificate for the key. */
  identity?: ParsedKey;
  /** Resolved SecurityKeyProvider; undefined uses OpenSSH's built-in support. */
  provider?: string;
  /**
   * Ask for the key file's passphrase or the security key's PIN. Undefined
   * skips the key; a rejection cancels the login.
   */
  ask(question: SecurityKeyQuestion): Promise<string | undefined>;
  /** Deadline, touch and signature hooks, as for the login agent. */
  agentOptions?: ResponsiveAgentOptions;
}

/**
 * Signs with a security key IdentityFile. The key handle in the file only
 * works together with the authenticator, through OpenSSH's FIDO middleware.
 * Rather than speak OpenSSH's internal ssh-sk-helper protocol or bind
 * libfido2, Muxus starts a private ssh-agent for this login, loads the file
 * with ssh-add and signs through the standard agent protocol. OpenSSH then
 * handles the passphrase, the PIN (relayed to the Muxus prompt through
 * SSH_ASKPASS) and the touch exactly as it does for `ssh`. Nothing starts
 * until the server accepts the key, and the agent ends with the login.
 */
export class SecurityKeyFileAgent extends BaseAgent<ParsedKey> {
  private session: Promise<ResponsiveAgent> | undefined;
  private readonly processes = new Set<ChildProcess>();
  private directory: string | undefined;
  private relay: net.Server | undefined;
  private agentLog = '';
  private passphrasePrompts = 0;
  private pinEntered = false;
  private lastQuestion: SecurityKeyQuestion | undefined;
  private disposed = false;

  constructor(private readonly options: SecurityKeyFileOptions) {
    super();
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    queueMicrotask(() => cb(undefined, [this.options.identity ?? this.options.publicKey]));
  }

  sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions, cb?: SignCallback): void;
  sign(pubKey: ParsedKey, data: Buffer, cb: SignCallback): void;
  sign(
    _pubKey: ParsedKey,
    data: Buffer,
    optionsOrCb: SigningRequestOptions | SignCallback,
    maybeCb?: SignCallback,
  ): void {
    const options = typeof optionsOrCb === 'function' ? {} : optionsOrCb;
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    if (!cb) return;
    // Loading the key, passphrase prompt included, is user time as well.
    const { pauseDeadline, resumeDeadline } = this.options.agentOptions ?? {};
    pauseDeadline?.();
    this.session ??= this.start();
    this.session.then(
      (client) => {
        resumeDeadline?.();
        this.pinEntered = false;
        this.agentLog = '';
        // The agent holds the plain key; a certificate is signed by that key.
        client.sign(this.options.publicKey, data, options, (err, signature) => {
          if (err instanceof SecurityKeyError && err.key) {
            // The private agent asks for the PIN at most once per signature.
            const reason =
              agentFailureReason(this.agentLog) ??
              (this.pinEntered ? 'the PIN was wrong, or it was not touched in time' : undefined);
            cb(reason ? new SecurityKeyError(reason, err.key) : err);
            return;
          }
          cb(err, signature);
        });
      },
      (err: Error) => {
        resumeDeadline?.();
        cb(err);
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.processes) {
      child.stdin?.destroy();
      child.kill();
    }
    this.processes.clear();
    this.relay?.close();
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
  }

  private get name(): string {
    return path.basename(this.options.file);
  }

  private get agentHint(): string {
    return `load it into your SSH agent with "ssh-add ${this.options.file}"`;
  }

  private async start(): Promise<ResponsiveAgent> {
    const type = securityKeyTypeName(this.options.publicKey.type);
    if (process.platform === 'win32') {
      throw new SecurityKeyError(`${this.name} is a security key (${type}). To use it, ${this.agentHint}`);
    }
    if (this.disposed) throw new SecurityKeyError('the login ended');
    const directory = privateDirectory();
    this.directory = directory;
    const relaySocket = path.join(directory, 'askpass.sock');
    const agentSocket = path.join(directory, 'agent.sock');
    const askpass = path.join(directory, 'askpass');
    const relayScript = path.join(directory, 'askpass.cjs');
    fs.writeFileSync(relayScript, ASKPASS_RELAY, { mode: 0o600 });
    fs.writeFileSync(
      askpass,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 NODE_OPTIONS= exec ${shellQuote(process.execPath)} ${shellQuote(relayScript)} ${shellQuote(relaySocket)} "$@"\n`,
      { mode: 0o700 },
    );
    await this.listen(relaySocket);

    const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' };
    delete env.SSH_AUTH_SOCK;
    delete env.SSH_AGENT_PID;
    delete env.SSH_SK_PROVIDER;
    const { provider } = this.options;
    if (provider) env.SSH_SK_PROVIDER = provider;

    const notFound = (tool: string) =>
      new SecurityKeyError(
        `${this.name} is a security key (${type}). Muxus signs with it through OpenSSH's ${tool}, which was not found: install the OpenSSH client, or ${this.agentHint}`,
      );
    try {
      await this.startAgent(agentSocket, env, provider);
    } catch (err) {
      if (missingTool(err)) throw notFound('ssh-agent');
      throw new SecurityKeyError(
        `could not start an ssh-agent for the security key ${this.name}: ${(err as Error).message}`,
      );
    }

    let added: { code: number | null; stderr: string };
    try {
      added = await this.run('ssh-add', ['--', this.options.file], { ...env, SSH_AUTH_SOCK: agentSocket });
    } catch (err) {
      if (missingTool(err)) throw notFound('ssh-add');
      throw new SecurityKeyError(`could not load the security key ${this.name}: ${(err as Error).message}`);
    }
    if (this.disposed) throw new SecurityKeyError('the login ended');
    if (added.code !== 0) {
      const reason = processReason(added.stderr);
      throw new SecurityKeyError(
        reason
          ? `could not load the security key ${this.name}: ${reason}`
          : this.lastQuestion?.retry
            ? `could not load the security key ${this.name}: the passphrase was not accepted`
            : `skipped the security key ${this.name}: no passphrase was entered`,
      );
    }
    const { agentOptions, identity } = this.options;
    return new ResponsiveAgent(ssh2.createAgent(agentSocket) as BaseAgent<ParsedKey>, {
      ...agentOptions,
      onSignature: (algorithm) => agentOptions?.onSignature?.(identity ? identity.type : algorithm),
      waitStatusMs: -1,
      // The private agent is ours and answers once OpenSSH gives up on the
      // authenticator; a PIN prompt may legitimately stay open for a while.
      securityKeyTimeoutMs: 0,
    });
  }

  /**
   * ssh-agent runs in the foreground, so its log explains a failed signature.
   * A watchdog (`cat` reading a pipe from Muxus) ends it if Muxus itself is
   * killed, so the agent can never outlive Muxus.
   */
  private startAgent(socketPath: string, env: NodeJS.ProcessEnv, provider: string | undefined): Promise<void> {
    const args = ['-D', '-a', socketPath];
    if (provider) {
      let allowed = provider;
      try {
        allowed = fs.realpathSync(provider);
      } catch {
        // ssh-add reports the missing provider.
      }
      args.push('-P', allowed);
    }
    return new Promise((resolve, reject) => {
      const agent = spawn('ssh-agent', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.track(agent);
      let stdout = '';
      agent.stdout?.setEncoding('utf8');
      agent.stderr?.setEncoding('utf8');
      agent.stderr?.on('data', (chunk: string) => {
        this.agentLog = (this.agentLog + chunk).slice(-MAX_AGENT_LOG);
      });
      agent.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        // Printed once the socket listens.
        if (!/Agent pid \d+/.test(stdout) || agent.pid === undefined) return;
        const watchdog = spawn('/bin/sh', ['-c', 'cat >/dev/null; kill "$1" 2>/dev/null', 'sh', String(agent.pid)], {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        watchdog.once('error', () => undefined);
        this.track(watchdog);
        agent.once('close', () => watchdog.stdin?.end());
        resolve();
      });
      agent.once('error', reject);
      agent.once('close', (code) => {
        reject(new Error(processReason(this.agentLog) || `ssh-agent exited with status ${code}`));
      });
    });
  }

  private run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      this.track(child);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
    });
  }

  private track(child: ChildProcess): void {
    if (this.disposed) {
      child.kill();
      return;
    }
    this.processes.add(child);
    child.once('close', () => this.processes.delete(child));
  }

  private listen(socketPath: string): Promise<void> {
    // The helper half-closes after its request and waits for the answer.
    const relay = net.createServer({ allowHalfOpen: true }, (socket) => {
      let request = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        request += chunk;
      });
      socket.on('error', () => undefined);
      socket.on('end', () => {
        let prompt: unknown;
        try {
          prompt = (JSON.parse(request) as { prompt?: unknown }).prompt;
        } catch {
          // Answered below as a cancelled prompt.
        }
        if (typeof prompt !== 'string') {
          socket.end('{}');
          return;
        }
        void this.answer(classifyAskpassPrompt(prompt)).then((answer) =>
          socket.end(JSON.stringify(answer === undefined ? {} : { answer })),
        );
      });
    });
    this.relay = relay;
    return new Promise((resolve, reject) => {
      relay.once('error', reject);
      relay.listen(socketPath, () => {
        relay.off('error', reject);
        resolve();
      });
    });
  }

  private async answer(question: SecurityKeyQuestion): Promise<string | undefined> {
    if (this.disposed) return undefined;
    // ssh-add asks again after every wrong passphrase; stop where ssh(1) does.
    if (question.kind === 'passphrase' && ++this.passphrasePrompts > MAX_PASSPHRASE_PROMPTS) {
      return undefined;
    }
    this.lastQuestion = question;
    try {
      const answer = await this.options.ask(question);
      if (answer && question.kind === 'pin') this.pinEntered = true;
      if (answer && question.presence) this.options.agentOptions?.onSecurityKey?.(this.options.publicKey);
      return answer || undefined;
    } catch {
      // The user dismissed the prompt; the caller is cancelling the login.
      return undefined;
    }
  }
}
