import { useCallback } from 'react';
import { useDeleteManagedHosts } from '../../api/host-delete.js';
import { useApplyFolderMoves } from '../../api/host-groups.js';
import { useReorderManagedHosts } from '../../api/host-order.js';
import { useDeleteHostProfile } from '../../api/profiles.js';
import { useDeleteHost } from '../../api/ssh-config.js';
import { confirmDeleteHost, confirmDeleteHosts } from '../../host-actions.js';
import { isSamePath } from '../../host-tree.js';
import {
  managedHostDisplayName,
  managedHostKey,
  managedHostRef,
  type ManagedHost,
} from '../../managed-hosts.js';
import { useUiStore } from '../../state/ui.js';
import { moveHostsPlan } from './folder-mutations.js';

/**
 * What can be done to saved hosts from a list of them: edit, move, delete,
 * reorder and re-file. The sidebar and the hosts tab both list hosts, and a
 * host has to behave the same in either, so the actions live here once.
 *
 * `hostByKey` resolves the keys a drag or a reorder names; `onDeleted` runs
 * once a bulk delete went through, to let go of a selection.
 */
export function useHostActions(
  hostByKey: ReadonlyMap<string, ManagedHost>,
  onDeleted?: () => void,
) {
  const setHostEditor = useUiStore((state) => state.setHostEditor);
  const setHostBulkEditor = useUiStore((state) => state.setHostBulkEditor);
  const setFolderDialog = useUiStore((state) => state.setFolderDialog);
  const deleteHost = useDeleteHost();
  const deleteProfile = useDeleteHostProfile();
  const deleteHosts = useDeleteManagedHosts();
  const reorder = useReorderManagedHosts();
  const applyFolderMoves = useApplyFolderMoves();

  /** One host opens its own editor; several open the bulk editor. */
  const editHosts = (targets: readonly ManagedHost[]) => {
    const [first] = targets;
    if (!first) return;
    if (targets.length > 1) {
      setHostBulkEditor(targets.map(managedHostKey));
      return;
    }
    setHostEditor(
      first.kind === 'ssh'
        ? { mode: 'edit', entry: first.entry }
        : { mode: 'edit-profile', entry: first.entry },
    );
  };

  const requestDelete = (host: ManagedHost) => {
    void confirmDeleteHost({
      name: managedHostDisplayName(host),
      sshFile: host.kind === 'ssh' ? host.entry.file : undefined,
    }).then((confirmed) => {
      if (!confirmed) return;
      if (host.kind === 'ssh') deleteHost.mutate(host.entry.alias);
      else deleteProfile.mutate(host.entry.id);
    });
  };

  /** One host takes the usual question; several are asked about, and deleted, together. */
  const requestDeleteHosts = (targets: readonly ManagedHost[]) => {
    const [first] = targets;
    if (!first) return;
    if (targets.length === 1) {
      requestDelete(first);
      return;
    }
    void confirmDeleteHosts(
      targets.map((host) => ({
        name: managedHostDisplayName(host),
        sshFile: host.kind === 'ssh' ? host.entry.file : undefined,
      })),
    ).then((confirmed) => {
      if (confirmed) deleteHosts.mutate(targets, { onSuccess: onDeleted });
    });
  };

  /** Pick a folder for hosts, starting from the one they share, if any. */
  const moveHosts = (targets: readonly ManagedHost[]) => {
    const [first] = targets;
    if (!first) return;
    const path = first.entry.metadata?.group ?? '';
    setFolderDialog({
      mode: 'move-hosts',
      hostKeys: targets.map(managedHostKey),
      hostName: targets.length === 1 ? managedHostDisplayName(first) : undefined,
      currentPath: targets.every((host) => isSamePath(host.entry.metadata?.group ?? '', path))
        ? path
        : '',
    });
  };

  const commitOrder = useCallback(
    (keys: readonly string[]) =>
      reorder.mutate(
        keys.flatMap((key) => {
          const host = hostByKey.get(key);
          return host ? [managedHostRef(host)] : [];
        }),
      ),
    [reorder, hostByKey],
  );

  /**
   * Commit a drag: change the folder of every host that moved, then their
   * order. `path` undefined means nothing changed folder and only the order
   * is written.
   */
  const dropHosts = useCallback(
    (hostKeys: readonly string[], path: string | undefined, order: string[]) => {
      const moves =
        path === undefined
          ? []
          : moveHostsPlan(
              hostKeys.flatMap((key) => {
                const host = hostByKey.get(key);
                return host ? [host] : [];
              }),
              path,
            );
      if (moves.length === 0) {
        commitOrder(order);
        return;
      }
      // Order is only meaningful once the hosts actually belong to the folder.
      void applyFolderMoves
        .mutateAsync({ moves })
        .then(({ failed }) => {
          if (failed === 0) commitOrder(order);
        })
        .catch(() => undefined);
    },
    [hostByKey, commitOrder, applyFolderMoves],
  );

  return {
    editHosts,
    requestDelete,
    requestDeleteHosts,
    moveHosts,
    commitOrder,
    dropHosts,
    reorder,
    applyFolderMoves,
    /** A reorder or a move is still being written. */
    mutating: reorder.isPending || applyFolderMoves.isPending,
  };
}
