import type { SessionProfile } from '@muxus/shared';
import { hasTabTransfer } from '../tab-drag.js';

/**
 * What dropping files onto a terminal does. SSH sessions upload them into the
 * shell's directory; local shells type their paths. Holding the insert
 * modifier types the paths into an SSH session too. Shift is the modifier
 * everywhere: Ctrl, Alt, Option and Command already pick copy, move, link or
 * a menu in the file managers drags come from.
 */
export type TerminalDropIntent =
  /** No directory means the home directory, not yet resolved. */
  | { kind: 'upload'; directory?: string; hint?: string }
  | { kind: 'insert'; byModifier: boolean }
  | { kind: 'unavailable'; message: string; hint?: string }
  /** Not a drop target: no overlay, and the drop is refused. */
  | { kind: 'refuse' };

export const INSERT_PATHS_HINT = 'Hold Shift to insert the local paths instead';

export interface TerminalDropContext {
  profileKind: SessionProfile['kind'];
  status: 'connecting' | 'connected' | 'interrupted' | 'closed';
  /** The live SSH connection; absent until the session is ready. */
  connId?: string;
  sftpAvailable?: boolean;
  /** Directory the shell last reported. */
  cwd?: string;
  /** The remote home directory, once known. */
  home?: string;
  /** The insert modifier is held. */
  insertModifier: boolean;
  /** Local paths of dropped files can be read (the desktop app). */
  canInsertPaths: boolean;
}

export function isInsertPathsModifier(event: Pick<MouseEvent, 'shiftKey'>): boolean {
  return event.shiftKey;
}

export function terminalDropIntent(context: TerminalDropContext): TerminalDropIntent {
  const { profileKind, canInsertPaths } = context;
  if (profileKind !== 'ssh' && profileKind !== 'local') return { kind: 'refuse' };
  if (context.status === 'closed') {
    return { kind: 'unavailable', message: 'The session has ended. Reconnect to drop files here.' };
  }
  if (profileKind === 'local') {
    return canInsertPaths
      ? { kind: 'insert', byModifier: false }
      : { kind: 'unavailable', message: 'File paths can only be inserted in the desktop app' };
  }
  if (context.insertModifier && canInsertPaths) return { kind: 'insert', byModifier: true };
  const hint = canInsertPaths ? INSERT_PATHS_HINT : undefined;
  if (context.sftpAvailable === false) {
    return { kind: 'unavailable', message: 'SFTP is disabled for this host', ...(hint ? { hint } : {}) };
  }
  if (!context.connId) {
    return { kind: 'unavailable', message: 'Waiting for the session to connect…', ...(hint ? { hint } : {}) };
  }
  const directory = context.cwd ?? context.home;
  return { kind: 'upload', ...(directory ? { directory } : {}), ...(hint ? { hint } : {}) };
}

/** The overlay shown while files are dragged over the terminal. */
export function dropOverlayText(
  intent: Exclude<TerminalDropIntent, { kind: 'refuse' }>,
): { title: string; caption?: string } {
  switch (intent.kind) {
    case 'upload':
      return {
        title: `Upload to ${intent.directory ?? 'the home folder'}`,
        ...(intent.hint ? { caption: intent.hint } : {}),
      };
    case 'insert':
      return intent.byModifier
        ? { title: 'Insert the local paths', caption: 'Release Shift to upload instead' }
        : { title: 'Insert the file paths' };
    case 'unavailable':
      return { title: intent.message, ...(intent.hint ? { caption: intent.hint } : {}) };
  }
}

export function dropEffectFor(intent: TerminalDropIntent): DataTransfer['dropEffect'] {
  if (intent.kind === 'upload') return 'copy';
  if (intent.kind === 'insert') return 'link';
  return 'none';
}

/**
 * Files dragged in from outside the window. Drags that start inside it (tabs,
 * hosts, file browser rows, images) are never offered as uploads.
 */
export function isExternalFileDrag(dataTransfer: DataTransfer | null, internalDrag: boolean): boolean {
  if (!dataTransfer || internalDrag || hasTabTransfer(dataTransfer)) return false;
  return Array.from(dataTransfer.types).includes('Files');
}

let internalDragActive = false;
let internalDragsTracked = false;

/** Start telling drags that begin in this window from drags into it. Idempotent. */
export function trackInternalDrags(target: Window = window): void {
  if (internalDragsTracked) return;
  internalDragsTracked = true;
  const start = () => {
    internalDragActive = true;
  };
  const end = () => {
    internalDragActive = false;
  };
  target.addEventListener('dragstart', start, true);
  target.addEventListener('dragend', end, true);
  // Bubbling, so drop targets still see the drag as internal.
  target.addEventListener('drop', end);
  // A drag whose source left the page ends without a dragend reaching the
  // window; no pointer events fire during a drag, so the next one clears it.
  target.addEventListener('pointermove', end, { capture: true, passive: true });
}

/** Whether the drag in progress started in this window. */
export function internalDragInProgress(): boolean {
  return internalDragActive;
}
