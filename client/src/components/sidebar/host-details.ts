import type { SavedHostProfile } from '@muxus/shared';
import type { ManagedHost } from '../../managed-hosts.js';
import { jumpHopLabel } from '../../saved-hosts.js';

/**
 * What a row deliberately does not draw. Jump chain, key, auth mode and
 * forwards are reference material, not things you act on from the list, so
 * they live in the row's hover card instead of as a row of grey glyphs.
 */
export function hostDetailLines(
  host: ManagedHost,
  savedProfiles?: readonly SavedHostProfile[],
): string[] {
  const lines: string[] = [];
  if (host.kind === 'profile') {
    const profile = host.entry.profile;
    if (profile.kind === 'rdp' || profile.kind === 'vnc') {
      if (profile.sshGateway) {
        lines.push(`via SSH gateway ${gatewayChain(profile.sshGateway, profile.sshGatewayFallbacks)}`);
      }
      if (profile.kind === 'rdp' && profile.domain) lines.push(`Domain ${profile.domain}`);
      if (profile.kind === 'vnc' && profile.viewOnly) lines.push('View only');
      if (profile.shareClipboard === false) lines.push('Clipboard not shared');
      return lines;
    }
    if (profile.kind === 'smb' || profile.kind === 'nfs') {
      if (profile.kind === 'nfs') lines.push(`NFSv${profile.version ?? '4'}${profile.readOnly ? ', read only' : ''}`);
      if (profile.kind === 'smb' && profile.username) lines.push(`as ${profile.username}`);
      if (profile.sshGateway) {
        lines.push(`via SSH gateway ${gatewayChain(profile.sshGateway, profile.sshGatewayFallbacks)}`);
      }
      return lines;
    }
    if (profile.kind === 'winrm') {
      lines.push(profile.https ? 'HTTPS' : 'HTTP, NTLM-encrypted');
      if (profile.auth === 'basic') lines.push('Basic authentication');
      if (profile.shell === 'powershell') lines.push('PowerShell');
      if (profile.sshGateway) {
        lines.push(`via SSH gateway ${gatewayChain(profile.sshGateway, profile.sshGatewayFallbacks)}`);
      }
      return lines;
    }
    if (profile.kind === 'web') {
      if (profile.sshGateway) {
        lines.push(`via SOCKS5 on ${gatewayChain(profile.sshGateway, profile.sshGatewayFallbacks)}`);
      }
      return lines;
    }
    if (profile.kind === 'gnmi' || profile.kind === 'netconf') {
      if (profile.sshGateway) {
        lines.push(`via SSH gateway ${gatewayChain(profile.sshGateway, profile.sshGatewayFallbacks)}`);
      }
      if (profile.kind === 'gnmi') {
        lines.push(
          profile.tls === 'plaintext'
            ? 'Plain text (no TLS)'
            : profile.tls === 'skip-verify'
              ? 'TLS, certificate not checked'
              : 'TLS',
        );
        if (profile.certFile) lines.push('Client certificate');
      }
      return lines;
    }
    if (profile.kind !== 'ssh') return lines;
    if (profile.proxyJump?.length) {
      lines.push(
        `via ${profile.proxyJump.map((hop) => jumpHopLabel(hop, savedProfiles)).join(' → ')}`,
      );
    }
    for (const route of profile.proxyJumpFallbacks ?? []) {
      lines.push(`or via ${route.map((hop) => jumpHopLabel(hop, savedProfiles)).join(' → ')}`);
    }
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
  for (const route of host.entry.metadata?.proxyJumpFallbacks ?? []) {
    lines.push(`or via ${route.join(' → ')}`);
  }
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

/** "a" or "a (then b, c)" for a gateway and its fallbacks. */
function gatewayChain(
  gateway: { target: string },
  fallbacks: readonly { target: string }[] | undefined,
): string {
  return fallbacks?.length
    ? `${gateway.target} (then ${fallbacks.map((fallback) => fallback.target).join(', ')})`
    : gateway.target;
}
