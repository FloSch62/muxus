import type { ManagedHost } from '../../managed-hosts.js';

/**
 * What a row deliberately does not draw. Jump chain, key, auth mode and
 * forwards are reference material, not things you act on from the list, so
 * they live in the row's hover card instead of as a row of grey glyphs.
 */
export function hostDetailLines(host: ManagedHost): string[] {
  const lines: string[] = [];
  if (host.kind === 'profile') {
    const profile = host.entry.profile;
    if (profile.kind !== 'ssh') return lines;
    if (profile.proxyJump?.length) lines.push(`via ${profile.proxyJump.join(' → ')}`);
    if (profile.identityFiles?.length) {
      lines.push(
        `Key ${profile.identityFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}`,
      );
    }
    if (profile.passwordOnly) lines.push('Password authentication');
    if (host.entry.metadata.consoleCompatibility) lines.push('Console compatibility');
    else if (host.entry.metadata.disableSftp) lines.push('SFTP disabled');
    if (profile.forwards?.length) {
      lines.push(
        `${profile.forwards.length} port forward${profile.forwards.length > 1 ? 's' : ''} on connect`,
      );
    }
    return lines;
  }
  if (host.entry.description) lines.push(host.entry.description);
  const resolved = host.entry.resolved;
  if (!resolved) return lines;
  if (resolved.proxyJump.length > 0) lines.push(`via ${resolved.proxyJump.join(' → ')}`);
  if (resolved.identityFiles.length > 0) {
    lines.push(`Key ${resolved.identityFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}`);
  }
  if (resolved.passwordOnly) lines.push('Password authentication');
  if (host.entry.metadata?.consoleCompatibility) lines.push('Console compatibility');
  else if (host.entry.metadata?.disableSftp) lines.push('SFTP disabled');
  if (resolved.forwards.length > 0) {
    lines.push(
      `${resolved.forwards.length} port forward${resolved.forwards.length > 1 ? 's' : ''} on connect`,
    );
  }
  return lines;
}
