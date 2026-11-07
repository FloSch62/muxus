import type { ForwardInfo, SavedHostProfile, SshGateway, SshProfile } from '@muxus/shared';
import { dialProfile } from './api/dial.js';
import { apiFetch } from './api/http.js';
import { windowDialHandlers } from './dial-prompts.js';
import { savedHostDisplayName } from './saved-hosts.js';
import { showErrorToast, showToast } from './state/toast.js';

/**
 * Saved web pages. Without a gateway the page opens straight away. With one,
 * Muxus connects to the gateway (asking for passwords and host keys like a
 * tunnel does), starts a SOCKS5 forward on a free local port, and opens the
 * page in a Muxus browser window that sends everything through it. The
 * window owns the forward and stops it when it closes, so it outlives a
 * reload of the app window that opened it.
 */

/** Hosts being opened right now, so a double click does not dial twice. */
const opening = new Set<string>();
/** Browser build only: proxies started for pages, reused while they run. */
const browserProxies = new Map<string, { forwardId: string; port: number }>();

export function openWebHost(host: SavedHostProfile): void {
  if (host.profile.kind !== 'web') return;
  if (opening.has(host.id)) return;
  opening.add(host.id);
  void openWebPage(host)
    .catch(showErrorToast)
    .finally(() => opening.delete(host.id));
}

async function openWebPage(host: SavedHostProfile): Promise<void> {
  if (host.profile.kind !== 'web') return;
  const { url, sshGateway } = host.profile;
  const title = savedHostDisplayName(host);
  const bridge = window.muxusDesktop;
  if (!bridge?.openWebWindow) {
    await openInBrowser(host.id, url, title, sshGateway);
    return;
  }

  // An open window comes to the front; nothing is dialed again.
  if (await bridge.focusWebWindow?.(host.id)) return;
  const proxy = sshGateway ? await startProxy(sshGateway) : undefined;
  const result = await bridge.openWebWindow({
    key: host.id,
    url,
    title,
    ...(proxy ? { proxy: proxyUrl(proxy.port), forwardId: proxy.forwardId } : {}),
  });
  if (result === 'invalid') {
    // The window refused the request and has already stopped the proxy.
    throw new Error(`“${title}” cannot be opened: ${url} is not an address a browser window can show.`);
  }
}

/**
 * Without the desktop app a browser tab cannot be given a proxy: start one
 * and say where it is, or open the page directly.
 */
async function openInBrowser(key: string, url: string, title: string, gateway: SshGateway | undefined) {
  if (!gateway) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  let proxy = browserProxies.get(key);
  // The forward may have been stopped from the forwarding panel, or lost with its gateway.
  if (proxy && !(await forwardRunning(proxy.forwardId))) proxy = undefined;
  if (!proxy) {
    proxy = await startProxy(gateway);
    browserProxies.set(key, proxy);
  }
  showToast(
    'info',
    `SOCKS5 proxy for “${title}” is running on 127.0.0.1:${proxy.port}.`,
    `Set it as your browser's SOCKS5 proxy (with remote DNS) and open ${url}. Stop it in the forwarding panel.`,
  );
}

function proxyUrl(port: number): string {
  return `socks5://127.0.0.1:${port}`;
}

async function forwardRunning(forwardId: string): Promise<boolean> {
  try {
    const { forwards } = await apiFetch<{ forwards: ForwardInfo[] }>('/api/forwards');
    return forwards.some((forward) => forward.id === forwardId && forward.status === 'active');
  } catch (err) {
    showErrorToast(err);
    return false;
  }
}

/**
 * Dial the gateway and start a SOCKS5 forward on a free local port. The
 * forward is independent of terminal tabs on the same connection, so
 * closing one does not stop the page's proxy. A dial that fails takes its
 * waiting sign-in prompts with it.
 */
async function startProxy(gateway: SshGateway): Promise<{ forwardId: string; port: number }> {
  const profile: SshProfile = {
    kind: 'ssh',
    target: gateway.target,
    ...(gateway.profileId ? { profileId: gateway.profileId } : {}),
  };
  const abort = new AbortController();
  let dialed;
  try {
    dialed = await dialProfile(profile, windowDialHandlers(abort.signal), abort.signal);
  } finally {
    abort.abort();
  }
  try {
    const started = await apiFetch<ForwardInfo>('/api/forwards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connId: dialed.connId, type: 'dynamic', bindPort: 0, independent: true }),
    });
    return { forwardId: started.id, port: started.bindPort };
  } finally {
    // The forward holds its own lease on the connection now.
    dialed.close();
  }
}
