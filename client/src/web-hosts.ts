import type { SavedHostProfile, SshGateway } from '@muxus/shared';
import { startGatewayForward, stopGatewayForward } from './gateway-forwards.js';
import { savedHostDisplayName } from './saved-hosts.js';
import { showErrorToast, showToast } from './state/toast.js';

/**
 * Saved web pages. Without a gateway the page opens straight away. With one,
 * Muxus connects to the gateway (asking for passwords and host keys like a
 * tunnel does), starts a SOCKS5 forward on a free local port, and opens the
 * page in a Muxus browser window that sends everything through it. The
 * forward stops when the window closes.
 */

/** Live proxies, by saved host ID, while their window is open. */
const proxies = new Map<string, { forwardId: string; port: number }>();
const opening = new Set<string>();

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
  const { url, sshGateway, sshGatewayFallbacks } = host.profile;
  const title = savedHostDisplayName(host);
  const bridge = window.muxusDesktop;
  const desktop = bridge?.openWebWindow
    ? (request: Parameters<NonNullable<typeof bridge.openWebWindow>>[0]) => bridge.openWebWindow!(request)
    : undefined;

  if (!sshGateway) {
    if (desktop) void desktop({ key: host.id, url, title });
    else window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const running = proxies.get(host.id);
  if (running && desktop) {
    void desktop({ key: host.id, url, title, proxy: proxyUrl(running.port) });
    return;
  }

  const proxy = running ?? (await startProxy([sshGateway, ...(sshGatewayFallbacks ?? [])]));
  proxies.set(host.id, proxy);
  if (!desktop) {
    // A browser tab cannot be given a proxy: say where it is instead.
    showToast(
      'info',
      `SOCKS5 proxy for “${title}” is running on 127.0.0.1:${proxy.port}.`,
      `Set it as your browser's SOCKS5 proxy (with remote DNS) and open ${url}. Stop it in the forwarding panel.`,
    );
    return;
  }
  const result = await desktop({ key: host.id, url, title, proxy: proxyUrl(proxy.port) });
  if (result === 'focused') return;
  // The window closed (or never opened): its proxy is not needed any more.
  proxies.delete(host.id);
  await stopProxy(proxy.forwardId);
}

function proxyUrl(port: number): string {
  return `socks5://127.0.0.1:${port}`;
}

async function startProxy(gateways: readonly SshGateway[]): Promise<{ forwardId: string; port: number }> {
  return startGatewayForward(gateways, { type: 'dynamic' });
}

async function stopProxy(forwardId: string): Promise<void> {
  await stopGatewayForward(forwardId);
}
