import type { ManagedHost } from '../../managed-hosts.js';
import { connectHost } from '../../session-actions.js';
import { useTabsStore } from '../../state/tabs.js';

/** Whether the host context menu may offer the SSH-backed file browser. */
export function managedHostSupportsSftp(
  host: ManagedHost,
): host is Extract<ManagedHost, { kind: 'ssh' }> {
  return (
    host.kind === 'ssh' &&
    host.entry.metadata?.disableSftp !== true &&
    host.entry.metadata?.consoleCompatibility !== true
  );
}

/**
 * Reveal the file browser on a usable tab for this host. Prefer a tab whose
 * SSH transport is already ready, then one still connecting; only dial a new
 * session when there is nothing suitable to reuse.
 */
export function openManagedHostSftp(host: ManagedHost): string | undefined {
  if (!managedHostSupportsSftp(host)) return undefined;

  const state = useTabsStore.getState();
  const matching = state.tabs.filter(
    (tab) =>
      tab.profile?.kind === 'ssh' &&
      tab.profile.target === host.entry.alias &&
      (tab.status === 'connecting' || tab.status === 'connected') &&
      tab.sftpAvailable !== false,
  );
  const reusable =
    matching.find((tab) => tab.id === state.activeId && !!tab.connId) ??
    matching.find((tab) => !!tab.connId) ??
    matching.find((tab) => tab.id === state.activeId) ??
    matching[0];
  const id = reusable?.id ?? connectHost(host.entry);
  const next = useTabsStore.getState();
  next.update(id, { sftpOpen: true });
  next.activate(id);
  return id;
}
