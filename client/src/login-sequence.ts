import {
  LOGIN_SEQUENCE_DEFAULT_TIMEOUT_SECONDS,
  LOGIN_SEQUENCE_MAX_STEPS,
  LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS,
  LOGIN_SEQUENCE_TEXT_MAX_LENGTH,
  type FolderSettingsRecord,
  type LoginSequence,
  type LoginSequenceStep,
} from '@muxus/shared';
import { newPreferenceId } from './command-buttons.js';
import { ancestorPaths, isSamePath, normalizeGroupPath } from './host-tree.js';

/**
 * How a host or folder gets its login sequence: from the folder above it,
 * none at all (switching an inherited one off), or its own steps.
 */
export type LoginSequenceMode = 'inherit' | 'none' | 'custom';

export interface LoginSequenceDraft {
  mode: LoginSequenceMode;
  /** Kept while another mode is picked, so switching back loses nothing. */
  steps: LoginSequenceStep[];
}

export type LoginStepKind = LoginSequenceStep['kind'];

export function newLoginStep(kind: LoginStepKind): LoginSequenceStep {
  const id = newPreferenceId('step');
  switch (kind) {
    case 'wait':
      return { id, kind, pattern: '', timeoutSeconds: LOGIN_SEQUENCE_DEFAULT_TIMEOUT_SECONDS };
    case 'send':
      return { id, kind, text: '', enter: true };
    case 'secret':
      return { id, kind, secretId: '', enter: true };
  }
}

/** A step switched to another kind keeps its id, and its text where that still fits. */
export function changeLoginStepKind(step: LoginSequenceStep, kind: LoginStepKind): LoginSequenceStep {
  if (step.kind === kind) return step;
  const next = { ...newLoginStep(kind), id: step.id };
  const text = step.kind === 'wait' ? step.pattern : step.kind === 'send' ? step.text : '';
  if (next.kind === 'wait') next.pattern = text;
  else if (next.kind === 'send') next.text = text;
  return next;
}

export function loginSequenceDraft(sequence: LoginSequence | undefined): LoginSequenceDraft {
  if (!sequence) return { mode: 'inherit', steps: [] };
  return { mode: sequence.steps.length > 0 ? 'custom' : 'none', steps: sequence.steps };
}

/** The stored form: null inherits, an empty list is none. */
export function loginSequenceFromDraft(draft: LoginSequenceDraft): LoginSequence | null {
  if (draft.mode === 'inherit') return null;
  return { steps: draft.mode === 'custom' ? draft.steps : [] };
}

/** Moves a step up (-1) or down (1); out-of-range moves change nothing. */
export function moveLoginStep(
  steps: readonly LoginSequenceStep[],
  index: number,
  offset: -1 | 1,
): LoginSequenceStep[] {
  const target = index + offset;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Why a regular expression cannot be used, or undefined when it compiles. */
export function waitPatternError(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression.';
  }
}

/** What is wrong with one step, phrased for the field it belongs to. */
export function loginStepProblem(step: LoginSequenceStep): string | undefined {
  switch (step.kind) {
    case 'wait': {
      if (!step.pattern) return 'Enter the text to wait for.';
      if (step.pattern.length > LOGIN_SEQUENCE_TEXT_MAX_LENGTH) return 'This text is too long.';
      if (step.regex) {
        const error = waitPatternError(step.pattern);
        if (error) return error;
      }
      const timeout = step.timeoutSeconds;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS) {
        return `Wait between 1 and ${LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS} seconds.`;
      }
      return undefined;
    }
    case 'send':
      if (!step.text && !step.enter) return 'Enter text to send, or press Enter.';
      if (step.text.length > LOGIN_SEQUENCE_TEXT_MAX_LENGTH) return 'This text is too long.';
      return undefined;
    case 'secret':
      return step.secretId ? undefined : 'Choose a secret from the password vault.';
  }
}

/** The first reason a draft cannot be saved, or null. */
export function loginSequenceProblem(draft: LoginSequenceDraft): string | null {
  if (draft.mode !== 'custom') return null;
  if (draft.steps.length === 0) return 'Add a login step, or choose no login sequence.';
  if (draft.steps.length > LOGIN_SEQUENCE_MAX_STEPS) {
    return `A login sequence can have up to ${LOGIN_SEQUENCE_MAX_STEPS} steps.`;
  }
  for (const [index, step] of draft.steps.entries()) {
    const problem = loginStepProblem(step);
    if (problem) return `Login sequence step ${index + 1}: ${problem}`;
  }
  return null;
}

function comparable(sequence: LoginSequence | null | undefined): string {
  if (!sequence) return 'inherit';
  return JSON.stringify(
    sequence.steps.map(({ id: _id, ...step }) =>
      step.kind === 'wait' ? { ...step, regex: step.regex === true } : step,
    ),
  );
}

/** Whether two stored sequences do the same thing; step ids do not count. */
export function sameLoginSequence(
  a: LoginSequence | null | undefined,
  b: LoginSequence | null | undefined,
): boolean {
  return comparable(a) === comparable(b);
}

export function sameLoginSequenceDraft(a: LoginSequenceDraft, b: LoginSequenceDraft): boolean {
  return sameLoginSequence(loginSequenceFromDraft(a), loginSequenceFromDraft(b));
}

/**
 * The sequence a host in `group` would take from its folders when it has none
 * of its own: the nearest folder that sets one wins, and an empty one there
 * means none. `folder` names the folder it comes from.
 */
export function inheritedLoginSequence(
  folders: readonly FolderSettingsRecord[] | undefined,
  group: string | undefined,
): { sequence: LoginSequence; folder: string } | undefined {
  const path = normalizeGroupPath(group);
  if (!path) return undefined;
  for (const candidate of [path, ...ancestorPaths(path).reverse()]) {
    const folder = folders?.find((entry) => isSamePath(entry.path, candidate));
    if (folder?.loginSequence) {
      return folder.loginSequence.steps.length > 0
        ? { sequence: folder.loginSequence, folder: folder.path }
        : undefined;
    }
  }
  return undefined;
}

/** A step as one line of text, as the editors and the tab describe it. */
export function loginStepSummary(step: LoginSequenceStep, secretName?: string): string {
  switch (step.kind) {
    case 'wait':
      return step.regex ? `Wait for a match of /${step.pattern}/` : `Wait for “${step.pattern}”`;
    case 'send':
      if (!step.text) return 'Press Enter';
      return `Send “${step.text}”${step.enter ? ' and Enter' : ''}`;
    case 'secret':
      return `Send the secret ${secretName ? `“${secretName}”` : 'from the vault'}${step.enter ? ' and Enter' : ''}`;
  }
}

/** Shape check for sequences read from a backup; the server validates the values again. */
export function isLoginSequence(value: unknown): value is LoginSequence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const steps = (value as { steps?: unknown }).steps;
  return (
    Array.isArray(steps) &&
    steps.length <= LOGIN_SEQUENCE_MAX_STEPS &&
    steps.every((step) => isLoginStep(step) && loginStepProblem(step) === undefined)
  );
}

function isLoginStep(value: unknown): value is LoginSequenceStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (typeof step.id !== 'string' || !step.id || step.id.length > 100) return false;
  switch (step.kind) {
    case 'wait':
      return (
        typeof step.pattern === 'string' &&
        (step.regex === undefined || typeof step.regex === 'boolean') &&
        typeof step.timeoutSeconds === 'number'
      );
    case 'send':
      return typeof step.text === 'string' && typeof step.enter === 'boolean';
    case 'secret':
      return typeof step.secretId === 'string' && step.secretId.length <= 200 && typeof step.enter === 'boolean';
    default:
      return false;
  }
}

/** Where a login sequence is set: a host or a folder, by the name the user knows it by. */
export interface LoginSequenceOwner {
  label: string;
  loginSequence?: LoginSequence;
}

/** The hosts and folders whose own login sequence types this vault secret. */
export function loginSequencesUsingSecret(
  owners: readonly LoginSequenceOwner[],
  secretId: string,
): string[] {
  return owners
    .filter((owner) =>
      owner.loginSequence?.steps.some((step) => step.kind === 'secret' && step.secretId === secretId),
    )
    .map((owner) => owner.label);
}
