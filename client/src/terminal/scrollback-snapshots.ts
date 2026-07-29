import type { SerializeAddon } from '@xterm/addon-serialize';
import {
  TERMINAL_SNAPSHOT_FORMAT_VERSION,
  TERMINAL_SNAPSHOT_MAX_CHARS,
  type TerminalSnapshotRecord,
} from '@muxus/shared';
import { apiFetch, authToken } from '../api/http.js';
import { requestBodyBytes } from '../unload-keepalive.js';

/** Scrollback depths a snapshot tries, largest first, until one fits its budget. */
export const SNAPSHOT_SCROLLBACK_LADDER: readonly number[] = [1_000, 400, 150, 50, 10];

/** Ceiling on the background snapshot while output keeps arriving. */
export const TERMINAL_SNAPSHOT_INTERVAL_MS = 10_000;

/** Idle gap after which output is snapshotted, so closing right after a
 *  command does not lose it to the interval above. */
export const TERMINAL_SNAPSHOT_QUIET_MS = 1_500;

const TERMINAL_HISTORY_DIVIDER_TEXT = '[end of restored output]';
// Zero-width characters survive xterm serialization without changing the
// divider's appearance. They give client-injected rows provenance that genuine
// terminal output containing the same visible text does not have.
const TERMINAL_HISTORY_DIVIDER_MARKER = '\u2063\u2060\u200b\u2063';
const MARKED_TERMINAL_HISTORY_DIVIDER_TEXT =
  `[${TERMINAL_HISTORY_DIVIDER_MARKER}end of restored output]`;

/** Written after replayed history, before the new session's output. */
export const TERMINAL_HISTORY_DIVIDER =
  `\r\n\x1b[90m${MARKED_TERMINAL_HISTORY_DIVIDER_TEXT}\x1b[0m\r\n`;

const ESC = String.fromCharCode(27);
const CURSOR_MOVE_FINALS = 'ABCDEFGHdf`';
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const LEGACY_DIVIDER_COLOR = new RegExp(
  `${ESC}\\[(?:[0-9:;]*;)?(?:90|38[;:]5[;:]8)(?:;[0-9:;]*)?m`,
);

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

/**
 * Remove the visual replay boundary before a terminal buffer becomes the next
 * snapshot. Otherwise every restore serializes the client-injected divider
 * and accumulates another copy on the following restore.
 *
 * New dividers carry an invisible marker, so a remote process can safely emit
 * the same visible text. Previously saved dividers have no provenance; migrate
 * only rows that also use the dark-gray color written by older clients.
 */
export function stripTerminalHistoryDividers(
  data: string,
  options: { includeLegacy?: boolean } = {},
): string {
  return data
    .split('\r\n')
    .filter((row) => {
      const visible = row.replace(CSI_SEQUENCE, '');
      if (visible === MARKED_TERMINAL_HISTORY_DIVIDER_TEXT) return false;
      if (!options.includeLegacy || visible !== TERMINAL_HISTORY_DIVIDER_TEXT) return true;

      const textStart = row.indexOf(TERMINAL_HISTORY_DIVIDER_TEXT);
      return !LEGACY_DIVIDER_COLOR.test(row.slice(0, textStart));
    })
    .join('\r\n');
}

export function snapshotRequestBody(data: string): string {
  return JSON.stringify({ data, formatVersion: TERMINAL_SNAPSHOT_FORMAT_VERSION });
}

/** Wire size of a snapshot. JSON escapes every ESC to six characters, so the
 *  body is several times the buffer and has to be measured, not estimated. */
export function snapshotBodyBytes(data: string): number {
  return requestBodyBytes(snapshotRequestBody(data));
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
        stripTerminalHistoryDividers(
          addon.serialize({ scrollback, excludeModes: true, excludeAltBuffer: true }),
        ),
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
    if (!snapshot) return null;
    return stripTerminalHistoryDividers(snapshot.data, {
      includeLegacy:
        (snapshot.formatVersion ?? 1) < TERMINAL_SNAPSHOT_FORMAT_VERSION,
    });
  } catch {
    return null;
  }
}

/** Save a snapshot without surfacing an optional-history failure to the UI. */
export async function putTerminalSnapshot(
  tabId: string,
  data: string,
  options: { keepalive?: boolean } = {},
): Promise<boolean> {
  const path = `/api/terminal-snapshots/${encodeURIComponent(tabId)}`;
  const body = snapshotRequestBody(data);
  try {
    if (!options.keepalive) {
      await apiFetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      return true;
    }
    // A closing window cancels its in-flight requests; keepalive lets this
    // last snapshot outlive the page.
    const response = await fetch(path, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      body,
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}
