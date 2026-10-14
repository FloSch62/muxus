import { z } from 'zod';
import {
  ANTI_IDLE_MAX_INTERVAL_SECONDS,
  ANTI_IDLE_MIN_INTERVAL_SECONDS,
  ANTI_IDLE_TEXT_MAX_LENGTH,
  LOGIN_SEQUENCE_MAX_STEPS,
  LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS,
  LOGIN_SEQUENCE_TEXT_MAX_LENGTH,
  MAX_PASTE_CHAR_DELAY_MS,
  MAX_PASTE_LINE_DELAY_MS,
  MAX_PASTE_PROMPT_TIMEOUT_MS,
  MIN_PASTE_PROMPT_TIMEOUT_MS,
  pastePatternProblem,
  TERMINAL_BACKSPACE_KEYS,
  TERMINAL_ENTER_KEYS,
} from '@muxus/shared';

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const keywordHighlightRuleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100).optional(),
  keyword: z.string().min(1).max(500),
  foreground: hexColorSchema,
  background: hexColorSchema.optional(),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean().optional(),
});

export const hostKeywordHighlightsSchema = z.object({
  inheritGlobal: z.boolean(),
  profileId: z.string().min(1).max(200).optional(),
  rules: z.array(keywordHighlightRuleSchema).max(100),
});

const loginStepIdSchema = z.string().min(1).max(100);

const loginSequenceStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: loginStepIdSchema,
      kind: z.literal('wait'),
      pattern: z.string().min(1).max(LOGIN_SEQUENCE_TEXT_MAX_LENGTH),
      regex: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(LOGIN_SEQUENCE_MAX_TIMEOUT_SECONDS),
    })
    .refine((step) => !step.regex || validRegex(step.pattern), {
      message: 'invalid regular expression',
      path: ['pattern'],
    }),
  z
    .object({
      id: loginStepIdSchema,
      kind: z.literal('send'),
      text: z.string().max(LOGIN_SEQUENCE_TEXT_MAX_LENGTH),
      enter: z.boolean(),
    })
    .refine((step) => step.text.length > 0 || step.enter, {
      message: 'a send step needs text or Enter',
      path: ['text'],
    }),
  z.object({
    id: loginStepIdSchema,
    kind: z.literal('secret'),
    secretId: z.string().min(1).max(200),
    enter: z.boolean(),
  }),
]);

/** Steps only; a secret step names its vault secret and never carries the value. */
export const loginSequenceSchema = z.object({
  steps: z.array(loginSequenceStepSchema).max(LOGIN_SEQUENCE_MAX_STEPS),
});

const pastePatternSchema = z
  .string()
  .refine((pattern) => pastePatternProblem(pattern) === undefined, 'unusable regular expression');

/** A paste's prompt waiting; a field left out uses the default. */
const pastePromptWaitSchema = z.object({
  promptPattern: pastePatternSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_PASTE_PROMPT_TIMEOUT_MS)
    .max(MAX_PASTE_PROMPT_TIMEOUT_MS)
    .optional(),
  errorPattern: pastePatternSchema.optional(),
});
/** Typed into an idle session as is; Enter only when the user asked for it. */
const antiIdleSchema = z
  .object({
    intervalSeconds: z
      .number()
      .int()
      .min(ANTI_IDLE_MIN_INTERVAL_SECONDS)
      .max(ANTI_IDLE_MAX_INTERVAL_SECONDS),
    // No control characters, so a hidden Enter or Ctrl+C cannot ride along.
    text: z
      .string()
      .max(ANTI_IDLE_TEXT_MAX_LENGTH)
      .refine((text) => !/\p{Cc}/u.test(text), 'control characters are not allowed'),
    enter: z.boolean(),
  })
  .refine((setting) => setting.text.length > 0 || setting.enter, {
    message: 'anti-idle needs text or Enter',
    path: ['text'],
  });

function validRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Muxus-owned display metadata, shared by OpenSSH hosts and saved profiles. */
export const metadataPatchSchema = z
  .object({
    displayName: z.string().max(200).nullable().optional(),
    // A group is a folder path ("Production/EU/Edge"), so the cap has to cover
    // several nested names rather than a single one.
    group: z.string().max(300).nullable().optional(),
    color: z.string().max(64).nullable().optional(),
    icon: z.string().max(64).nullable().optional(),
    terminalScheme: z.string().min(1).max(64).nullable().optional(),
    terminalFontColor: hexColorSchema.nullable().optional(),
    terminalBackgroundColor: hexColorSchema.nullable().optional(),
    keywordHighlights: hostKeywordHighlightsSchema.nullable().optional(),
    // The id of a command button group, which lives in the client's preferences.
    commandButtonGroup: z.string().min(1).max(200).nullable().optional(),
    // Paste pacing in milliseconds; null follows the Terminal settings.
    pasteLineDelayMs: z.number().int().min(0).max(MAX_PASTE_LINE_DELAY_MS).nullable().optional(),
    pasteCharDelayMs: z.number().int().min(0).max(MAX_PASTE_CHAR_DELAY_MS).nullable().optional(),
    // Null turns waiting for the prompt off.
    pastePromptWait: pastePromptWaitSchema.nullable().optional(),
    // Null turns anti-idle off.
    antiIdle: antiIdleSchema.nullable().optional(),
    // Keys and echo; null goes back to what xterm.js does.
    backspaceKey: z.enum(TERMINAL_BACKSPACE_KEYS).nullable().optional(),
    enterKey: z.enum(TERMINAL_ENTER_KEYS).nullable().optional(),
    implicitCr: z.boolean().nullable().optional(),
    localEcho: z.boolean().nullable().optional(),
    disableSftp: z.boolean().optional(),
    consoleCompatibility: z.boolean().optional(),
    loginSequence: loginSequenceSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'at least one metadata field is required');
