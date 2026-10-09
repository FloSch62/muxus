import type { LoginSequence } from '@muxus/shared';
import { folderChain } from '../util/folder-paths.js';

/** A host whose Muxus metadata can carry a login sequence. */
export type LoginSequenceHost = { alias: string } | { profileId: string };

/** What the resolver needs to know; satisfied by MuxusDatabase. */
export interface LoginSequenceSource {
  /** The host's own sequence (absent inherits) and its folder; undefined for an unknown host. */
  hostLoginSequence(
    host: LoginSequenceHost,
  ): { loginSequence?: LoginSequence; group?: string } | undefined;
  folderSettingsForPath(path: string): { loginSequence?: LoginSequence } | undefined;
}

/**
 * The sequence a session to this host runs: the host's own, or else the
 * nearest folder's that sets one. An empty sequence on the host or on a
 * folder means "none" and ends the search, so a folder's sequence can be
 * switched off for one host or one subfolder.
 */
export function resolveLoginSequence(
  source: LoginSequenceSource,
  host: LoginSequenceHost,
): LoginSequence | undefined {
  const entry = source.hostLoginSequence(host);
  if (!entry) return undefined;
  let sequence = entry.loginSequence;
  if (!sequence) {
    for (const path of folderChain(entry.group)) {
      sequence = source.folderSettingsForPath(path)?.loginSequence;
      if (sequence) break;
    }
  }
  return sequence && sequence.steps.length > 0 ? sequence : undefined;
}
