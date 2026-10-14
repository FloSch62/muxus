import {
  MAX_PASTE_PROMPT_TIMEOUT_MS,
  MIN_PASTE_PROMPT_TIMEOUT_MS,
  pastePatternProblem,
  validPastePromptTimeout,
  type PastePromptWait,
} from '@muxus/shared';

/** A host's prompt waiting in the shape the editors edit; an empty field uses the default. */
export interface PastePromptWaitDraft {
  enabled: boolean;
  /** Kept while switched off, so switching back loses nothing. */
  promptPattern: string;
  /** Milliseconds as typed. */
  timeoutMs: string;
  errorPattern: string;
}

export function pastePromptWaitDraft(
  setting: Partial<PastePromptWait> | undefined,
): PastePromptWaitDraft {
  return {
    enabled: setting !== undefined,
    promptPattern: setting?.promptPattern ?? '',
    timeoutMs: setting?.timeoutMs === undefined ? '' : String(setting.timeoutMs),
    errorPattern: setting?.errorPattern ?? '',
  };
}

/** The stored form: null is off, and an empty field is left out so it follows the default. */
export function pastePromptWaitFromDraft(
  draft: PastePromptWaitDraft,
): Partial<PastePromptWait> | null {
  if (!draft.enabled) return null;
  return {
    ...(draft.promptPattern ? { promptPattern: draft.promptPattern } : {}),
    ...(draft.timeoutMs.trim() ? { timeoutMs: Number(draft.timeoutMs) } : {}),
    ...(draft.errorPattern ? { errorPattern: draft.errorPattern } : {}),
  };
}

/** Why a typed timeout cannot be saved, or undefined; empty uses the default. */
export function pastePromptTimeoutProblem(text: string): string | undefined {
  if (!text.trim() || validPastePromptTimeout(Number(text))) return undefined;
  return `Between ${MIN_PASTE_PROMPT_TIMEOUT_MS} and ${MAX_PASTE_PROMPT_TIMEOUT_MS} ms.`;
}

/** The first reason a draft cannot be saved, or null. */
export function pastePromptWaitProblem(draft: PastePromptWaitDraft): string | null {
  if (!draft.enabled) return null;
  const prompt = draft.promptPattern ? pastePatternProblem(draft.promptPattern) : undefined;
  if (prompt) return `Prompt pattern: ${prompt}`;
  const timeout = pastePromptTimeoutProblem(draft.timeoutMs);
  if (timeout) return `Prompt timeout: ${timeout}`;
  const error = draft.errorPattern ? pastePatternProblem(draft.errorPattern) : undefined;
  if (error) return `Error pattern: ${error}`;
  return null;
}

export function samePastePromptWaitDraft(a: PastePromptWaitDraft, b: PastePromptWaitDraft): boolean {
  return (
    JSON.stringify(pastePromptWaitFromDraft(a)) === JSON.stringify(pastePromptWaitFromDraft(b))
  );
}

/** Shape and range check for a setting read from a backup; the server validates it again. */
export function isPastePromptWait(value: unknown): value is Partial<PastePromptWait> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const setting = value as Record<string, unknown>;
  const pattern = (field: unknown) =>
    field === undefined || (typeof field === 'string' && pastePatternProblem(field) === undefined);
  return (
    pattern(setting.promptPattern) &&
    (setting.timeoutMs === undefined || validPastePromptTimeout(setting.timeoutMs)) &&
    pattern(setting.errorPattern)
  );
}
