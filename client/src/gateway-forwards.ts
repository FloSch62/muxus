import type { ForwardInfo, SshGateway, SshProfile } from '@muxus/shared';
import { apiFetch } from './api/http.js';
import { dialProfile, type DialHandlers } from './api/dial.js';
import { showToast } from './state/toast.js';

/**
 * Prompts for SSH gateways that pages and shares go through: the app root
 * answers them wherever in the window the host was opened from.
 */
let handlers: DialHandlers | undefined;

export function setGatewayDialHandlers(next: DialHandlers | undefined): void {
  handlers = next;
}

export function gatewayDialHandlers(): DialHandlers {
  if (!handlers) throw new Error('Muxus is not ready to sign in to the SSH gateway yet.');
  return handlers;
}

export type GatewayForward =
  | { type: 'dynamic' }
  | { type: 'local'; targetHost: string; targetPort: number };

/**
 * Dial the first gateway that answers and start a forward on a free local
 * port. A gateway that fails hands over to the next; a cancelled sign-in
 * stops there. The forward keeps the SSH connection up until it is stopped.
 */
export async function startGatewayForward(
  gateways: readonly SshGateway[],
  forward: GatewayForward,
): Promise<{ forwardId: string; port: number }> {
  const answer = gatewayDialHandlers();
  let lastError: unknown;
  for (const [i, gateway] of gateways.entries()) {
    const next = gateways[i + 1];
    const profile: SshProfile = {
      kind: 'ssh',
      target: gateway.target,
      ...(gateway.profileId ? { profileId: gateway.profileId } : {}),
    };
    let cancelled = false;
    const watched: DialHandlers = {
      ...answer,
      onAuthPrompt: async (request) => {
        const result = await answer.onAuthPrompt(request);
        if (result === null) cancelled = true;
        return result;
      },
    };
    let dialed;
    try {
      dialed = await dialProfile(profile, watched);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!next || cancelled) break;
      showToast('warning', `The SSH gateway ${gateway.target} failed — trying ${next.target}.`, message);
      continue;
    }
    try {
      const started = await apiFetch<ForwardInfo>('/api/forwards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connId: dialed.connId, bindPort: 0, ...forward }),
      });
      return { forwardId: started.id, port: started.bindPort };
    } finally {
      // The forward holds its own lease on the connection now.
      dialed.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not reach any SSH gateway.');
}

export async function stopGatewayForward(forwardId: string): Promise<void> {
  await apiFetch(`/api/forwards/${encodeURIComponent(forwardId)}`, { method: 'DELETE' }).catch(() => undefined);
}
