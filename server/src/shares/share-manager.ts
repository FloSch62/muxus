import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  NfsProfile,
  ShareMount,
  ShareMountRequest,
  ShareMountResponse,
  SmbProfile,
} from '@muxus/shared';
import { desktopPasswordAccount, desktopPasswordLabel, type PasswordVault } from '../security/password-vault.js';
import { HttpProblem } from '../util/errors.js';
import { runWithPrompts, type PromptRunResult } from './run-with-prompts.js';
import {
  mountFailureHint,
  mountFolderName,
  nfsPlan,
  smbPlan,
  ShareUnsupportedError,
  type MountPlan,
  type ShareCommand,
  type SharePlatform,
} from './share-commands.js';

interface ActiveMount extends ShareMount {
  plan: MountPlan;
}

export interface ShareManagerOptions {
  savedShare(id: string): { name: string; profile: SmbProfile | NfsProfile } | undefined;
  vault?: PasswordVault;
  /** Stop the gateway forward a mount used. */
  stopForward?(id: string): void;
  /** Test seams. */
  platform?: NodeJS.Platform;
  mountRoot?: string;
  run?: typeof runWithPrompts;
}

/**
 * SMB and NFS shares mounted with the operating system's own clients. Mount
 * points live in ~/Muxus Shares on macOS and Linux; GVFS (Linux SMB) and
 * Windows choose their own places. Muxus remembers what it mounted until it
 * is unmounted or the app quits; mounts outlive the app, as Finder's do.
 */
export class ShareManager {
  private readonly mounts = new Map<string, ActiveMount>();
  private readonly busy = new Set<string>();
  private readonly platform: SharePlatform | undefined;
  private readonly mountRoot: string;
  private readonly run: typeof runWithPrompts;

  constructor(private readonly options: ShareManagerOptions) {
    const platform = options.platform ?? process.platform;
    this.platform = platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : undefined;
    this.mountRoot = options.mountRoot ?? path.join(os.homedir(), 'Muxus Shares');
    this.run = options.run ?? runWithPrompts;
  }

  list(): ShareMount[] {
    for (const [id, mount] of this.mounts) {
      if (!this.stillMounted(mount)) this.mounts.delete(id);
    }
    return [...this.mounts.values()].map(publicMount);
  }

  async mount(id: string, request: ShareMountRequest): Promise<ShareMountResponse> {
    const saved = this.options.savedShare(id);
    if (!saved) throw new HttpProblem(404, 'This saved share no longer exists.');
    if (!this.platform) throw new HttpProblem(400, `Mounting shares is not supported on ${process.platform}.`);
    if (this.busy.has(id)) throw new HttpProblem(409, 'This share is already being mounted.');
    this.busy.add(id);
    try {
      return await this.mountShare(id, saved.name, saved.profile, request);
    } finally {
      this.busy.delete(id);
    }
  }

  private async mountShare(
    id: string,
    name: string,
    profile: SmbProfile | NfsProfile,
    request: ShareMountRequest,
  ): Promise<ShareMountResponse> {
    const existing = this.mounts.get(id);
    if (existing && this.stillMounted(existing)) {
      // A forward started for this open is not needed: the mount has its own.
      if (request.forwardId && request.forwardId !== existing.forwardId) this.options.stopForward?.(request.forwardId);
      return { status: 'mounted', mount: publicMount(existing), alreadyMounted: true };
    }
    this.mounts.delete(id);

    const platform = this.platform!;
    const defaultPort = profile.kind === 'smb' ? 445 : 2049;
    const address = request.forwardPort
      ? { host: '127.0.0.1', port: request.forwardPort }
      : { host: profile.host, port: profile.kind === 'smb' ? (profile.port ?? defaultPort) : defaultPort };
    const planOptions = {
      mountRoot: this.mountRoot,
      folderName: mountFolderName(name),
      ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
    };
    let plan: MountPlan;
    try {
      plan = profile.kind === 'smb' ? smbPlan(platform, profile, address, planOptions) : nfsPlan(platform, profile, address, planOptions);
    } catch (err) {
      if (err instanceof ShareUnsupportedError) throw new HttpProblem(400, err.message);
      throw err;
    }

    if (plan.mountPoint) {
      await mkdir(plan.mountPoint, { recursive: true });
      // Mounted earlier (by Muxus before a restart, or by hand): just use it.
      if (isMountPoint(plan.mountPoint)) {
        const mount = this.remember(id, profile, plan, plan.mountPoint, request.forwardId);
        return { status: 'mounted', mount: publicMount(mount), alreadyMounted: true };
      }
    }

    // Passwords: what was typed, else what the vault remembers for this share.
    const username = profile.kind === 'smb' ? (profile.username?.trim() ?? '') : '';
    const ref = profile.kind === 'smb' ? this.passwordRef(profile, username) : undefined;
    let password = request.password;
    let fromVault = false;
    if (password === undefined && ref && username) {
      password = await this.savedPassword(ref.account);
      fromVault = password !== undefined;
    }
    const { domain, user } = splitUser(username);

    let result: PromptRunResult;
    try {
      result = await this.run(plan.mount, { password, user, domain });
    } catch (err) {
      await this.removeMountPoint(plan);
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpProblem(
        502,
        /ENOENT|not found|No such file/i.test(message)
          ? (mountFailureHint(platform, profile.kind, 'not found') ?? `${plan.mount.command} is not installed.`)
          : message,
      );
    }

    if (result.exitCode !== 0) {
      await this.removeMountPoint(plan);
      if (profile.kind === 'smb' && (result.unanswered === 'password' || result.refused === 'password' || looksLikeBadLogin(result.output))) {
        return {
          status: 'password-required',
          label: ref?.label ?? `SMB ${profile.host}`,
          rememberable: this.canRemember(),
          // A remembered password that no longer works counts as rejected too.
          rejected: result.refused === 'password' || (fromVault && result.unanswered !== 'password') || looksLikeBadLogin(result.output),
        };
      }
      const detail = lastLines(result.output) || `${plan.mount.command} exited with code ${result.exitCode}.`;
      const hint = mountFailureHint(platform, profile.kind, result.output);
      throw new HttpProblem(502, hint ? `${detail}\n${hint}` : detail);
    }

    const where = plan.path ?? plan.pathFromOutput?.(result.output) ?? this.findGvfsPath(profile);
    if (!where) throw new HttpProblem(502, 'The share was mounted, but Muxus could not tell where.');
    if (plan.pathFromOutput) {
      // Windows NFS: unmount the drive letter the mount chose.
      plan.unmount = { ...plan.unmount, args: ['-f', where.replace(/\\$/, '')] };
    }
    const mount = this.remember(id, profile, plan, where, request.forwardId);

    let warning: string | undefined;
    if (request.remember && request.password && ref && username) {
      warning = await this.rememberPassword(ref, request.password);
    }
    return { status: 'mounted', mount: publicMount(mount), alreadyMounted: false, ...(warning ? { warning } : {}) };
  }

  async unmount(id: string): Promise<{ unmounted: boolean }> {
    const mount = this.mounts.get(id);
    if (!mount) return { unmounted: false };
    const result = await this.run(mount.plan.unmount, {}).catch((err: unknown) => ({
      exitCode: 1,
      output: err instanceof Error ? err.message : String(err),
    }));
    if (result.exitCode !== 0 && this.stillMounted(mount)) {
      throw new HttpProblem(
        409,
        /busy|in use/i.test(result.output)
          ? 'The share is in use. Close the files and folders open on it and try again.'
          : lastLines(result.output) || 'The share could not be unmounted.',
      );
    }
    this.mounts.delete(id);
    await this.removeMountPoint(mount.plan);
    if (mount.forwardId) this.options.stopForward?.(mount.forwardId);
    return { unmounted: true };
  }

  private remember(
    id: string,
    profile: SmbProfile | NfsProfile,
    plan: MountPlan,
    where: string,
    forwardId: string | undefined,
  ): ActiveMount {
    const folder = profile.kind === 'smb' ? profile.folder?.trim() : undefined;
    const mount: ActiveMount = {
      profileId: id,
      path: where,
      openPath: folder ? joinShare(where, folder) : where,
      ...(forwardId ? { forwardId } : {}),
      plan,
    };
    this.mounts.set(id, mount);
    return mount;
  }

  private stillMounted(mount: ActiveMount): boolean {
    if (mount.plan.mountPoint) return isMountPoint(mount.plan.mountPoint);
    return existsSync(mount.path);
  }

  private findGvfsPath(profile: SmbProfile | NfsProfile): string | undefined {
    if (profile.kind !== 'smb' || typeof process.getuid !== 'function') return undefined;
    const root = `/run/user/${process.getuid()}/gvfs`;
    try {
      const share = `share=${profile.share.toLowerCase()}`;
      const found = readdirSync(root).find(
        (entry) => entry.startsWith('smb-share:') && entry.includes(share) && entry.includes(profile.host.toLowerCase()),
      );
      return found ? path.join(root, found) : undefined;
    } catch {
      return undefined;
    }
  }

  private async removeMountPoint(plan: MountPlan): Promise<void> {
    // Only an empty folder Muxus made goes; rmdir refuses anything else.
    if (plan.mountPoint && !isMountPoint(plan.mountPoint)) await rmdir(plan.mountPoint).catch(() => undefined);
  }

  // --- passwords ---

  private passwordRef(profile: SmbProfile, username: string): { account: string; label: string } {
    const gateway = profile.sshGateway;
    const input = {
      protocol: 'smb' as const,
      user: username,
      host: profile.host,
      port: profile.port ?? 445,
      gateway: gateway ? (gateway.profileId ? `profile:${gateway.profileId}` : `ssh:${gateway.target}`) : '',
      gatewayLabel: gateway?.target,
      domain: '',
    };
    return {
      account: desktopPasswordAccount(input),
      label: `${desktopPasswordLabel(input)}/${profile.share}`,
    };
  }

  private canRemember(): boolean {
    const status = this.options.vault?.status();
    return !!status && status.configured && !status.locked;
  }

  private async savedPassword(account: string): Promise<string | undefined> {
    const vault = this.options.vault;
    if (!vault || !vault.hasSshPassword(account) || vault.status().locked) return undefined;
    return vault.sshPassword(account).catch(() => undefined);
  }

  private async rememberPassword(ref: { account: string; label: string }, password: string): Promise<string | undefined> {
    const vault = this.options.vault;
    if (!vault || !this.canRemember()) {
      return 'The password was not remembered: set up or unlock the password vault in Settings first.';
    }
    try {
      await vault.rememberSshPassword(ref.account, ref.label, password);
      return undefined;
    } catch (err) {
      return `The password was not remembered: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function publicMount(mount: ActiveMount): ShareMount {
  const { plan: _plan, ...rest } = mount;
  return rest;
}

/** A folder with another filesystem mounted on it. */
export function isMountPoint(folder: string): boolean {
  try {
    return statSync(folder).dev !== statSync(path.dirname(folder)).dev;
  } catch {
    return false;
  }
}

function joinShare(root: string, folder: string): string {
  const parts = folder.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..');
  if (/^\\\\|^[A-Z]:\\/i.test(root)) return [root.replace(/\\$/, ''), ...parts].join('\\');
  return path.join(root, ...parts);
}

function splitUser(username: string): { domain: string; user: string } {
  const slash = username.indexOf('\\');
  return slash >= 0 ? { domain: username.slice(0, slash), user: username.slice(slash + 1) } : { domain: '', user: username };
}

function looksLikeBadLogin(output: string): boolean {
  return /authentication error|logon failure|access denied|permission denied|bad password|NT_STATUS_LOGON_FAILURE|System error 86|System error 1326/i.test(
    output,
  );
}

function lastLines(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join('\n');
}

export type { ShareCommand };
