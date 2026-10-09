import {
  MAX_PASTE_CHAR_DELAY_MS,
  MAX_PASTE_LINE_DELAY_MS,
  type OpenSshProfileMetadata,
  type PastePacing,
} from '@muxus/shared';

export type PasteDelayKind = 'line' | 'char';

export const PASTE_DELAY_MAX: Record<PasteDelayKind, number> = {
  line: MAX_PASTE_LINE_DELAY_MS,
  char: MAX_PASTE_CHAR_DELAY_MS,
};

/** A typed delay: empty is undefined, anything else a whole number clamped to range. */
export function parsePasteDelay(text: string, kind: PasteDelayKind): number | undefined {
  if (!text.trim()) return undefined;
  const value = Math.round(Number(text));
  if (!Number.isFinite(value)) return undefined;
  return Math.min(PASTE_DELAY_MAX[kind], Math.max(0, value));
}

interface PastePacingDefaults {
  pasteLineDelayMs: number;
  pasteCharDelayMs: number;
}

/** A host's own paste delays where it sets them, the Terminal settings' otherwise. */
export function hostPastePacing(
  defaults: PastePacingDefaults,
  host: Pick<OpenSshProfileMetadata, 'pasteLineDelayMs' | 'pasteCharDelayMs'> | undefined,
): PastePacing {
  return {
    lineDelayMs: host?.pasteLineDelayMs ?? defaults.pasteLineDelayMs,
    charDelayMs: host?.pasteCharDelayMs ?? defaults.pasteCharDelayMs,
  };
}

/** A paste's running time, rounded for reading: "under a second", "about 12 s", "about 4 min". */
export function formatPasteDuration(ms: number): string {
  if (ms < 1000) return 'under a second';
  if (ms < 90_000) return `about ${Math.round(ms / 1000)} s`;
  return `about ${Math.round(ms / 60_000)} min`;
}
