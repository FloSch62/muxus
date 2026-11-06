import path from 'node:path';
import type { NfsProfile, SmbProfile } from '@muxus/shared';

export type SharePlatform = 'darwin' | 'linux' | 'win32';

/** Where a share is reached: its own address, or a local forward through a gateway. */
export interface ShareAddress {
  host: string;
  port: number;
}

/** One command the mount needs, with the prompts it may ask on its terminal. */
export interface ShareCommand {
  command: string;
  args: string[];
  /** Answers by prompt, matched against the command's output in order of appearance. */
  answers?: Array<{ prompt: RegExp; answer: 'password' | 'user' | 'domain' }>;
}

export interface MountPlan {
  /** A folder to create first and remove after unmounting (macOS and Linux mounts). */
  mountPoint?: string;
  mount: ShareCommand;
  unmount: ShareCommand;
  /** Where the share appears; `undefined` when only the command's output can say (drive letters). */
  path?: string;
  /** Read the path from the mount command's output (Windows NFS drive letter). */
  pathFromOutput?: (output: string) => string | undefined;
}

export class ShareUnsupportedError extends Error {}

/** A folder name for a share's mount point: readable and safe on every system. */
export function mountFolderName(name: string): string {
  const safe = name
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return safe || 'share';
}

/** `CORP\alice` → domain and user; `alice@corp` and `alice` stay whole. */
export function splitDomainUser(username: string): { domain: string; user: string } {
  const slash = username.indexOf('\\');
  return slash >= 0
    ? { domain: username.slice(0, slash), user: username.slice(slash + 1) }
    : { domain: '', user: username };
}

const enc = (value: string) => encodeURIComponent(value);

export function smbPlan(
  platform: SharePlatform,
  profile: SmbProfile,
  address: ShareAddress,
  options: { mountRoot: string; folderName: string; uid?: number },
): MountPlan {
  const username = profile.username?.trim() ?? '';
  const { domain, user } = splitDomainUser(username);
  const hostPort = address.port === 445 ? address.host : `${address.host}:${address.port}`;

  if (platform === 'darwin') {
    const mountPoint = path.join(options.mountRoot, options.folderName);
    const who = username ? `${domain ? `${enc(domain)};` : ''}${enc(user)}@` : 'guest@';
    return {
      mountPoint,
      path: mountPoint,
      mount: {
        command: '/sbin/mount_smbfs',
        // -N: a guest mount must not wait for a password nobody will type.
        args: [...(username ? [] : ['-N']), `//${who}${hostPort}/${enc(profile.share)}`, mountPoint],
        answers: [{ prompt: /password/i, answer: 'password' }],
      },
      unmount: { command: '/usr/sbin/diskutil', args: ['unmount', mountPoint] },
    };
  }

  if (platform === 'linux') {
    // GVFS mounts without root, under /run/user/<uid>/gvfs.
    const who = username ? `${domain ? `${enc(domain)};` : ''}${enc(user)}@` : '';
    const url = `smb://${who}${hostPort}/${enc(profile.share)}`;
    const gvfsName = `smb-share:${address.port === 445 ? '' : `port=${address.port},`}server=${address.host.toLowerCase()},share=${profile.share.toLowerCase()}${user ? `,user=${user}` : ''}`;
    return {
      path: options.uid === undefined ? undefined : `/run/user/${options.uid}/gvfs/${gvfsName}`,
      mount: {
        command: 'gio',
        args: ['mount', ...(username ? [] : ['--anonymous']), url],
        answers: [
          { prompt: /password/i, answer: 'password' },
          { prompt: /domain/i, answer: 'domain' },
          { prompt: /user/i, answer: 'user' },
        ],
      },
      unmount: { command: 'gio', args: ['mount', '-u', url] },
    };
  }

  // Windows: SMB is always port 445 there, so a forward to another port cannot work.
  if (address.port !== 445 || address.host !== profile.host) {
    throw new ShareUnsupportedError(
      'Windows can only reach SMB on port 445 of the server itself, so this share cannot go through an SSH gateway on Windows.',
    );
  }
  const unc = `\\\\${profile.host}\\${profile.share}`;
  return {
    path: unc,
    mount: {
      command: 'net',
      // No user: Windows signs in as you (single sign-on on a domain).
      args: ['use', unc, ...(username ? ['*', `/user:${username}`] : []), '/persistent:no'],
      answers: [{ prompt: /password/i, answer: 'password' }],
    },
    unmount: { command: 'net', args: ['use', unc, '/delete', '/y'] },
  };
}

export function nfsPlan(
  platform: SharePlatform,
  profile: NfsProfile,
  address: ShareAddress,
  options: { mountRoot: string; folderName: string },
): MountPlan {
  const version = profile.version ?? '4';
  const forwarded = address.host !== profile.host || address.port !== 2049;
  if (forwarded && version !== '4') {
    throw new ShareUnsupportedError(
      'NFSv3 needs several ports (portmapper and mountd), so it cannot go through an SSH gateway. Use NFSv4.',
    );
  }
  const source = `${address.host}:${profile.export}`;

  if (platform === 'win32') {
    if (forwarded) {
      throw new ShareUnsupportedError('The Windows NFS client cannot use another port, so it cannot go through an SSH gateway.');
    }
    const unc = `\\\\${profile.host}${profile.export.replace(/\//g, '\\')}`;
    return {
      mount: {
        command: 'C:\\Windows\\System32\\mount.exe',
        args: ['-o', `anon${profile.readOnly ? ',ro' : ''}`, unc, '*'],
      },
      pathFromOutput: (output) => {
        const drive = /\b([A-Z]):\s+is now successfully connected/i.exec(output)?.[1];
        return drive ? `${drive.toUpperCase()}:\\` : undefined;
      },
      // Replaced with the drive letter once the mount says which.
      unmount: { command: 'C:\\Windows\\System32\\umount.exe', args: ['-f', unc] },
    };
  }

  const mountPoint = path.join(options.mountRoot, options.folderName);
  const nfsOptions = [
    platform === 'darwin' ? `vers=${version}` : `nfsvers=${version}`,
    ...(address.port === 2049 ? [] : [`port=${address.port}`]),
    ...(profile.readOnly ? ['ro'] : []),
  ].join(',');
  return {
    mountPoint,
    path: mountPoint,
    mount:
      platform === 'darwin'
        ? { command: '/sbin/mount_nfs', args: ['-o', nfsOptions, source, mountPoint] }
        : { command: 'mount', args: ['-t', 'nfs', '-o', nfsOptions, source, mountPoint] },
    unmount: platform === 'darwin'
      ? { command: '/usr/sbin/diskutil', args: ['unmount', mountPoint] }
      : { command: 'umount', args: [mountPoint] },
  };
}

/** A sentence for a failed mount, with what usually fixes it. */
export function mountFailureHint(platform: SharePlatform, kind: 'smb' | 'nfs', output: string): string | undefined {
  if (kind === 'nfs' && /not permitted|permission denied|only root|must be superuser/i.test(output)) {
    return platform === 'linux'
      ? 'Mounting NFS needs root on Linux. Add a line for this export with the “user” option to /etc/fstab, or mount it with sudo.'
      : platform === 'darwin'
        ? 'macOS refused the NFS mount. Servers that require a reserved port need the “insecure” export option, or mount with Finder → Go → Connect to Server.'
        : undefined;
  }
  if (kind === 'nfs' && platform === 'win32' && /not recognized|cannot find|is not/i.test(output)) {
    return 'Turn on “Client for NFS” in Windows Features to mount NFS shares.';
  }
  if (kind === 'smb' && platform === 'linux' && /not found|no such file/i.test(output)) {
    return 'Mounting SMB on Linux needs gio and gvfs-smb (gvfs-backends on Debian and Ubuntu).';
  }
  return undefined;
}
