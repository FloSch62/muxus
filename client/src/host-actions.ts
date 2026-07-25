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
