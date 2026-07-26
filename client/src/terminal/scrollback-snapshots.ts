import type { SerializeAddon } from '@xterm/addon-serialize';
import { TERMINAL_SNAPSHOT_MAX_CHARS, type TerminalSnapshotRecord } from '@muxus/shared';
import { apiFetch, authToken } from '../api/http.js';

/** Scrollback depths a snapshot tries, largest first, until one fits its budget. */
export const SNAPSHOT_SCROLLBACK_LADDER: readonly number[] = [1_000, 400, 150, 50, 10];

/** Ceiling on the background snapshot while output keeps arriving. */
export const TERMINAL_SNAPSHOT_INTERVAL_MS = 10_000;

/** Idle gap after which output is snapshotted, so closing right after a
 *  command does not lose it to the interval above. */
export const TERMINAL_SNAPSHOT_QUIET_MS = 1_500;

/**
 * Browsers cap the total body of keepalive requests at 64 KiB, and a request
 * that exceeds it fails outright — the unload snapshot has to fit under it.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;

/** Written after replayed history, before the new session's output. */
export const TERMINAL_HISTORY_DIVIDER = '\r\n\x1b[90m[end of restored output]\x1b[0m\r\n';

const ESC = String.fromCharCode(27);
const CURSOR_MOVE_FINALS = 'ABCDEFGHdf`';

/** Start index of a cursor-move sequence (ESC [ params final) ending exactly
 *  at `end`, or `end` itself when none does. A plain scan — regexes over
 *  newline runs backtrack catastrophically on this input. */
function trailingCursorMoveStart(data: string, end: number): number {
  if (end < 3 || !CURSOR_MOVE_FINALS.includes(data[end - 1]!)) return end;
  let index = end - 2;
  while (index >= 0 && ((data[index]! >= '0' && data[index]! <= '9') || data[index] === ';')) {
    index--;
  }
  return index >= 1 && data[index] === '[' && data[index - 1] === ESC ? index - 1 : end;
}

/**
 * A serialized buffer ends with the blank remainder of the old viewport and a
 * cursor-repositioning sequence. Replayed as-is, that tail pushes the history
 * a screenful above the divider — drop it so the divider hugs the last line.
 */
export function trimReplayTail(data: string): string {
  let end = data.length;
  for (;;) {
    if (end > 0 && (data[end - 1] === '\n' || data[end - 1] === '\r')) {
      end--;
      continue;
    }
    const start = trailingCursorMoveStart(data, end);
    if (start === end) return data.slice(0, end);
    end = start;
  }
}

export function snapshotRequestBody(data: string): string {
  return JSON.stringify({ data });
}

/** Wire size of a snapshot. JSON escapes every ESC to six characters, so the
 *  body is several times the buffer and has to be measured, not estimated. */
export function snapshotBodyBytes(data: string): number {
  return new TextEncoder().encode(snapshotRequestBody(data)).length;
}

/**
 * Serialized recent buffer, or undefined when there is nothing worth keeping.
 * Modes and the alt buffer are excluded so a replay can never leave a fresh
 * terminal stuck in a full-screen application's state. Depth steps down until
 * the result fits both the stored cap and any caller-supplied wire budget.
 */
export function serializeScrollback(
  addon: SerializeAddon,
  options: { maxBodyBytes?: number } = {},
): string | undefined {
  try {
    for (const scrollback of SNAPSHOT_SCROLLBACK_LADDER) {
      const data = trimReplayTail(
        addon.serialize({ scrollback, excludeModes: true, excludeAltBuffer: true }),
      );
      if (data.length === 0) return undefined;
      if (data.length > TERMINAL_SNAPSHOT_MAX_CHARS) continue;
      if (options.maxBodyBytes !== undefined && snapshotBodyBytes(data) > options.maxBodyBytes) {
        continue;
      }
      return data;
    }
  } catch {
    /* a terminal mid-teardown cannot be serialized */
  }
  return undefined;
}

export async function fetchTerminalSnapshot(tabId: string): Promise<string | null> {
  try {
    const { snapshot } = await apiFetch<{ snapshot: TerminalSnapshotRecord | null }>(
      `/api/terminal-snapshots/${encodeURIComponent(tabId)}`,
    );
    return snapshot?.data ?? null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: losing a snapshot only costs some replayable history. */
export function putTerminalSnapshot(
  tabId: string,
  data: string,
  options: { keepalive?: boolean } = {},
): void {
  const path = `/api/terminal-snapshots/${encodeURIComponent(tabId)}`;
  const body = snapshotRequestBody(data);
  if (!options.keepalive) {
    void apiFetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => undefined);
    return;
  }
  // A closing window cancels its in-flight requests; keepalive lets this last
  // snapshot outlive the page, the way the workspace layout flush does.
  void fetch(path, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${authToken()}`,
      'content-type': 'application/json',
    },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
