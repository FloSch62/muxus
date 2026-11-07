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
    if (profile.kind === 'web') {
      if (profile.sshGateway) lines.push(`via SOCKS5 on ${profile.sshGateway.target}`);
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
    const route = jumpRouteLine(profile.proxyJump, profile.proxyJumpFallbacks, (hop) =>
      jumpHopLabel(hop, savedProfiles),
    );
    if (route) lines.push(route);
    if (profile.identityFiles?.length) {
      lines.push(
        `Key ${profile.identityFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}`,
      );
    }
    if (profile.passwordOnly) lines.push('Password authentication');
    if (host.entry.metadata.systemOpenSsh) lines.push('System OpenSSH');
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
  const route = jumpRouteLine(resolved.proxyJump, host.entry.metadata?.proxyJumpFallbacks);
  if (route) lines.push(route);
  if (resolved.identityFiles.length > 0) {
    lines.push(`Key ${resolved.identityFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}`);
  }
  if (resolved.passwordOnly) lines.push('Password authentication');
  if (host.entry.metadata?.systemOpenSsh) lines.push('System OpenSSH');
  if (host.entry.metadata?.consoleCompatibility) lines.push('Console compatibility');
  else if (host.entry.metadata?.disableSftp) lines.push('SFTP disabled');
  if (resolved.forwards.length > 0) {
    lines.push(
      `${resolved.forwards.length} port forward${resolved.forwards.length > 1 ? 's' : ''} on connect`,
    );
  }
  return lines;
}

/**
 * One line for a jump route and its fallbacks: "via a → b (then c, d → e)".
 * An alias whose ProxyJump was removed from ssh_config still tries its saved
 * fallbacks after dialing directly, so that reads "Direct, then via c".
 */
function jumpRouteLine(
  route: readonly string[] | undefined,
  fallbacks: readonly (readonly string[])[] | undefined,
  label: (hop: string) => string = (hop) => hop,
): string | undefined {
  const chain = (hops: readonly string[]) => hops.map(label).join(' → ');
  const then = (fallbacks ?? []).map(chain).join(', ');
  if (!route?.length) return then ? `Direct, then via ${then}` : undefined;
  return then ? `via ${chain(route)} (then ${then})` : `via ${chain(route)}`;
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
