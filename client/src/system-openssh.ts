import type { SshHostEntry, TunnelRecord } from '@muxus/shared';
import type { ManagedHost } from './managed-hosts.js';

/** What a greyed-out control says when a system OpenSSH host cannot do it. */
export const SYSTEM_OPENSSH_UNAVAILABLE = 'Not available with system OpenSSH';
export const SYSTEM_OPENSSH_WINDOWS_UNAVAILABLE = 'Not available with system OpenSSH on Windows';

/** A greyed-out action's name, for controls that show only one line of text. */
export function unavailableWithSystemOpenSsh(label: string): string {
  return `${label} (not available with system OpenSSH)`;
}

export function managedHostUsesSystemOpenSsh(host: ManagedHost): boolean {
  return host.kind === 'ssh'
    ? host.entry.metadata?.systemOpenSsh === true
    : host.entry.metadata.systemOpenSsh === true;
}

/** A tunnel linked to a host's config dials that host, which needs the built-in client. */
export function tunnelUsesSystemOpenSsh(
  tunnel: Pick<TunnelRecord, 'target' | 'sshOptions'>,
  hosts: readonly SshHostEntry[],
): boolean {
  if (tunnel.sshOptions) return false;
  return hosts.some(
    (host) => host.aliases.includes(tunnel.target) && host.metadata?.systemOpenSsh === true,
  );
}
