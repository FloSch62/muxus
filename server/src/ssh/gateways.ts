import type { SshProfile } from '@muxus/shared';
import {
  STOP_FALLBACK,
  type ConnectIo,
  type MuxedConnectionLease,
  type SshConnectionManager,
} from './connection-manager.js';
import type { ConnectionLeaseOwner } from './connection-leases.js';

/** An SSH host a desktop, management or web connection is reached through. */
export interface SshGatewayRef {
  target: string;
  profileId?: string;
}

/** The primary gateway, then its fallbacks, in the order to try them. */
export function gatewayCandidates(profile: {
  sshGateway?: SshGatewayRef;
  sshGatewayFallbacks?: readonly SshGatewayRef[];
}): SshGatewayRef[] {
  if (!profile.sshGateway) return [];
  return [profile.sshGateway, ...(profile.sshGatewayFallbacks ?? [])];
}

export function gatewaySshProfile(gateway: SshGatewayRef): SshProfile {
  return {
    kind: 'ssh',
    target: gateway.target,
    ...(gateway.profileId ? { profileId: gateway.profileId } : {}),
  };
}

/**
 * Connect to the first gateway that answers. A gateway that fails passes the
 * attempt to the next one, saying so in the status line; a cancelled sign-in
 * stops there, since the user chose to stop. The last failure is thrown.
 */
export async function connectGateway(
  connections: Pick<SshConnectionManager, 'connect'>,
  candidates: readonly SshGatewayRef[],
  io: ConnectIo,
  owner: ConnectionLeaseOwner,
  closed: () => boolean = () => false,
): Promise<{ lease: MuxedConnectionLease; gateway: SshGatewayRef }> {
  if (candidates.length === 0) throw new Error('no SSH gateway is set');
  for (let i = 0; ; i++) {
    const gateway = candidates[i]!;
    io.status(`Connecting to the SSH gateway ${gateway.target} …`, { transient: true });
    try {
      const lease = await connections.connect(gatewaySshProfile(gateway), io, owner);
      return { lease, gateway };
    } catch (err) {
      const next = candidates[i + 1];
      const message = err instanceof Error ? err.message : String(err);
      if (!next || closed() || STOP_FALLBACK.test(message)) throw err;
      io.status(`The SSH gateway ${gateway.target} failed (${message}) — trying ${next.target} …`);
    }
  }
}
