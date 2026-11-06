import type { SavedHostProfile, ShareMountRequest, ShareMountResponse } from '@muxus/shared';
import { apiFetch } from './api/http.js';
import { gatewayDialHandlers, startGatewayForward, stopGatewayForward } from './gateway-forwards.js';
import { savedHostDisplayName } from './saved-hosts.js';
import { showErrorToast, showToast } from './state/toast.js';

const PASSWORD_ATTEMPTS = 3;
const opening = new Set<string>();

/**
 * Open a saved SMB or NFS share: mount it with the operating system's own
 * client (through a forward on its SSH gateway when it has one) and show it
 * in the file manager. A share that is already mounted just opens.
 */
export function openShareHost(host: SavedHostProfile): void {
  if (host.profile.kind !== 'smb' && host.profile.kind !== 'nfs') return;
  if (opening.has(host.id)) return;
  opening.add(host.id);
  void mountShare(host)
    .catch(showErrorToast)
    .finally(() => opening.delete(host.id));
}

async function mountShare(host: SavedHostProfile): Promise<void> {
  const profile = host.profile;
  if (profile.kind !== 'smb' && profile.kind !== 'nfs') return;
  const title = savedHostDisplayName(host);

  let forward: { forwardId: string; port: number } | undefined;
  if (profile.sshGateway) {
    forward = await startGatewayForward([profile.sshGateway, ...(profile.sshGatewayFallbacks ?? [])], {
      type: 'local',
      targetHost: profile.host,
      targetPort: profile.kind === 'smb' ? (profile.port ?? 445) : 2049,
    });
  }
  // Until the mount works the forward is ours to stop; after, the mount owns it.
  let handedOver = false;
  try {
    let request: ShareMountRequest = forward ? { forwardPort: forward.port, forwardId: forward.forwardId } : {};
    for (let attempt = 0; attempt <= PASSWORD_ATTEMPTS; attempt++) {
      const result = await apiFetch<ShareMountResponse>(`/api/shares/${encodeURIComponent(host.id)}/mount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (result.status === 'mounted') {
        handedOver = true;
        if (result.warning) showToast('warning', result.warning);
        await openMountedFolder(result.mount.openPath, title);
        return;
      }
      if (attempt === PASSWORD_ATTEMPTS) break;
      const username = profile.kind === 'smb' ? profile.username : undefined;
      const answer = await gatewayDialHandlers().onAuthPrompt({
        name: 'SMB logon',
        host: profile.host,
        instructions: result.rejected
          ? 'The server rejected the password. Try again.'
          : `Enter the password${username ? ` for ${username}` : ''} to mount “${title}”.`,
        prompts: [{ prompt: 'Password', echo: false }],
        ...(result.rememberable ? { rememberPassword: { label: result.label, existing: false } } : {}),
      });
      if (!answer || answer.skipped) return;
      request = { ...request, password: answer.answers[0] ?? '', remember: answer.rememberPassword === true };
    }
    throw new Error(`The server rejected the password for “${title}”.`);
  } finally {
    if (forward && !handedOver) await stopGatewayForward(forward.forwardId);
  }
}

async function openMountedFolder(folder: string, title: string): Promise<void> {
  const opened = await window.muxusDesktop?.openFolder?.(folder).catch(() => false);
  if (opened) return;
  showToast('success', `“${title}” is mounted at ${folder}.`);
}

/** Unmount a share Muxus mounted, stopping its gateway forward too. */
export async function unmountShareHost(host: SavedHostProfile): Promise<void> {
  try {
    const { unmounted } = await apiFetch<{ unmounted: boolean }>(
      `/api/shares/${encodeURIComponent(host.id)}/unmount`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    showToast(
      unmounted ? 'success' : 'info',
      unmounted ? `Unmounted “${savedHostDisplayName(host)}”.` : `“${savedHostDisplayName(host)}” is not mounted by Muxus.`,
    );
  } catch (err) {
    showErrorToast(err);
  }
}
