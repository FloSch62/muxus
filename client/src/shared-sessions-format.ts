import type { SavedHostSessionProfile } from '@muxus/shared';

/** A session list Muxus writes for others to follow. */
export const SHARED_SESSIONS_FORMAT = 'muxus-shared-sessions';
export const SHARED_SESSIONS_VERSION = 1;

/** One host of a list. Nothing in it is a secret. */
export interface SharedSessionsDocumentHost {
  /** Unique inside the list; jump hosts and gateways are named by it. */
  id: string;
  name: string;
  /** Folder inside the folder the list is followed into. */
  folder?: string;
  color?: string;
  icon?: string;
  profile: Record<string, unknown> & { kind: SavedHostSessionProfile['kind'] };
}

export interface SharedSessionsDocument {
  format: typeof SHARED_SESSIONS_FORMAT;
  version: typeof SHARED_SESSIONS_VERSION;
  name: string;
  createdAt: string;
  hosts: SharedSessionsDocumentHost[];
}
