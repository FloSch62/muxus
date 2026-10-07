import { confirmAction } from './state/dialogs.js';

/** `/home/me/.ssh/config.d/work` → `~/.ssh/config.d/work`, on either platform. */
export function shortenSshPath(path: string): string {
  return path.replace(/^.*([\\/]\.ssh[\\/])/, '~/.ssh/');
}

/**
 * The one "delete this host" question. The sidebar's context menu and both
 * host editors ask it, so the wording — and the promise that the previous
 * config file is kept as a backup — is identical wherever you delete from.
 */
export function confirmDeleteHost(options: {
  name: string;
  /** Set for OpenSSH hosts: the config file the block will be removed from. */
  sshFile?: string;
}): Promise<boolean> {
  return confirmAction({
    title: `Delete “${options.name}”?`,
    description: options.sshFile
      ? `The Host block is removed from ${shortenSshPath(options.sshFile)}. A backup of the previous file is kept next to it as config.muxus.bak.`
      : 'This removes the saved host from Muxus. It does not change the remote device or serial port.',
    confirmLabel: 'Delete',
    destructive: true,
  });
}

/** One host in a bulk delete, described the way `confirmDeleteHost` takes it. */
export interface DeleteHostTarget {
  name: string;
  sshFile?: string;
}

/**
 * The same question for a selection. It names the hosts, so a stray
 * Ctrl/Cmd-click does not disappear into a count, and says what happens to each
 * kind: OpenSSH blocks leave their config files, saved hosts leave Muxus.
 */
export function confirmDeleteHosts(hosts: readonly DeleteHostTarget[]): Promise<boolean> {
  const names = hosts.map((host) => `“${host.name}”`);
  const listed =
    names.length > 4
      ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      : names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
        : (names[0] ?? '');
  const files = [...new Set(hosts.flatMap((host) => (host.sshFile ? [host.sshFile] : [])))];
  const blocks = hosts.filter((host) => host.sshFile).length;
  const saved = hosts.length - blocks;
  const [file] = files;
  const sentences = [`${listed}.`];
  if (blocks > 0 && file) {
    sentences.push(
      files.length === 1
        ? `${blocks} Host block${blocks === 1 ? ' is' : 's are'} removed from ${shortenSshPath(file)}, and a backup of the previous file is kept next to it as ${file.split(/[\\/]/).at(-1)}.muxus.bak.`
        : `${blocks} Host blocks are removed from ${files.length} config files, and a backup of each previous file is kept next to it with a .muxus.bak suffix.`,
    );
  }
  if (saved > 0) {
    sentences.push(
      `${saved} host${saved === 1 ? '' : 's'} saved in Muxus ${saved === 1 ? 'is' : 'are'} removed. No remote device or serial port changes.`,
    );
  }
  return confirmAction({
    title: `Delete ${hosts.length} hosts?`,
    description: sentences.join(' '),
    confirmLabel: `Delete ${hosts.length} hosts`,
    destructive: true,
  });
}
