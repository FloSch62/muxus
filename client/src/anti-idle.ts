import {
  ANTI_IDLE_MAX_INTERVAL_SECONDS,
  ANTI_IDLE_MIN_INTERVAL_SECONDS,
  ANTI_IDLE_TEXT_MAX_LENGTH,
  type AntiIdle,
} from '@muxus/shared';

/** The interval offered when anti-idle is first switched on. */
const DEFAULT_ANTI_IDLE_INTERVAL_SECONDS = 60;

/** A host's anti-idle setting in the shape the editors edit. */
export interface AntiIdleDraft {
  enabled: boolean;
  /** Seconds as typed; kept with the text while switched off, so switching back loses nothing. */
  intervalSeconds: string;
  text: string;
  enter: boolean;
}

export function antiIdleDraft(setting: AntiIdle | undefined): AntiIdleDraft {
  if (!setting) {
    return {
      enabled: false,
      intervalSeconds: String(DEFAULT_ANTI_IDLE_INTERVAL_SECONDS),
      text: '',
      enter: false,
    };
  }
  return {
    enabled: true,
    intervalSeconds: String(setting.intervalSeconds),
    text: setting.text,
    enter: setting.enter,
  };
}

/** The stored form: null is off. */
export function antiIdleFromDraft(draft: AntiIdleDraft): AntiIdle | null {
  if (!draft.enabled) return null;
  return { intervalSeconds: Number(draft.intervalSeconds), text: draft.text, enter: draft.enter };
}

/** Why the interval cannot be saved, or undefined. */
export function antiIdleIntervalProblem(draft: AntiIdleDraft): string | undefined {
  const seconds = Number(draft.intervalSeconds);
  if (
    !draft.intervalSeconds.trim() ||
    !Number.isInteger(seconds) ||
    seconds < ANTI_IDLE_MIN_INTERVAL_SECONDS ||
    seconds > ANTI_IDLE_MAX_INTERVAL_SECONDS
  ) {
    return `Between ${ANTI_IDLE_MIN_INTERVAL_SECONDS} and ${ANTI_IDLE_MAX_INTERVAL_SECONDS} seconds.`;
  }
  return undefined;
}

/** The first reason a draft cannot be saved, or null. */
export function antiIdleProblem(draft: AntiIdleDraft): string | null {
  if (!draft.enabled) return null;
  const interval = antiIdleIntervalProblem(draft);
  if (interval) return `Anti-idle interval: ${interval}`;
  if (!draft.text && !draft.enter) return 'Anti-idle: enter text to type, or press Enter.';
  if (draft.text.length > ANTI_IDLE_TEXT_MAX_LENGTH) {
    return `Anti-idle text can be up to ${ANTI_IDLE_TEXT_MAX_LENGTH} characters.`;
  }
  // Enter is the toggle's job; a hidden one, a tab or a Ctrl+C would not show in the field.
  if (/\p{Cc}/u.test(draft.text)) return 'Anti-idle text cannot contain control characters.';
  return null;
}

export function sameAntiIdleDraft(a: AntiIdleDraft, b: AntiIdleDraft): boolean {
  return JSON.stringify(antiIdleFromDraft(a)) === JSON.stringify(antiIdleFromDraft(b));
}

/** Shape and range check for a setting read from a backup; the server validates it again. */
export function isAntiIdle(value: unknown): value is AntiIdle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const setting = value as Record<string, unknown>;
  return (
    typeof setting.intervalSeconds === 'number' &&
    typeof setting.text === 'string' &&
    typeof setting.enter === 'boolean' &&
    antiIdleProblem({
      enabled: true,
      intervalSeconds: String(setting.intervalSeconds),
      text: setting.text,
      enter: setting.enter,
    }) === null
  );
}
