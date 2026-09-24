import type { KeywordHighlightProfile, KeywordHighlightRule } from '@muxus/shared';
import { newPreferenceId } from './command-buttons.js';
import { keywordPatternError } from './terminal/keyword-matching.js';

export const HIGHLIGHT_PROFILE_FORMAT = 'muxus-keyword-highlighting-profiles';
/** Version 2 added regex rules. */
export const HIGHLIGHT_PROFILE_VERSION = 2;
/** Files without regex rules keep version 1 so older releases can still import them. */
const LITERAL_HIGHLIGHT_PROFILE_VERSION = 1;
export const MAX_HIGHLIGHT_PROFILE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_KEYWORD_HIGHLIGHT_PROFILES = 100;
export const MAX_KEYWORD_HIGHLIGHT_RULES = 100;

type HighlightProfileVersion =
  | typeof LITERAL_HIGHLIGHT_PROFILE_VERSION
  | typeof HIGHLIGHT_PROFILE_VERSION;

export interface HighlightProfileDocument {
  format: typeof HIGHLIGHT_PROFILE_FORMAT;
  version: HighlightProfileVersion;
  createdAt: string;
  profiles: KeywordHighlightProfile[];
}

/** Build the portable file shared by the highlighting settings import/export UI. */
export function createHighlightProfileDocument(
  profiles: readonly KeywordHighlightProfile[],
): HighlightProfileDocument {
  if (!isKeywordHighlightProfileArray(profiles) || profiles.length === 0) {
    throw new Error('Select at least one valid highlighting profile to export.');
  }
  return {
    format: HIGHLIGHT_PROFILE_FORMAT,
    // A release that predates regex rules would otherwise match their patterns
    // as literal text; the newer version makes it refuse the file instead.
    version: profiles.some((profile) => profile.rules.some((rule) => rule.regex))
      ? HIGHLIGHT_PROFILE_VERSION
      : LITERAL_HIGHLIGHT_PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    profiles: profiles.map(copyProfile),
  };
}

/** Parse an untrusted, standalone highlighting-profile file. */
export function parseHighlightProfileDocument(text: string): HighlightProfileDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This highlighting profile file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.format !== HIGHLIGHT_PROFILE_FORMAT) {
    throw new Error('This is not a Muxus highlighting profile file.');
  }
  if (
    parsed.version !== LITERAL_HIGHLIGHT_PROFILE_VERSION &&
    parsed.version !== HIGHLIGHT_PROFILE_VERSION
  ) {
    throw new Error(
      typeof parsed.version === 'number'
        ? `Highlighting profile version ${parsed.version} is not supported.`
        : 'This file is missing a supported highlighting profile version.',
    );
  }
  if (
    typeof parsed.createdAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    !isKeywordHighlightProfileArray(parsed.profiles) ||
    parsed.profiles.length === 0
  ) {
    throw new Error('The highlighting profile file is incomplete or invalid.');
  }
  // Version 1 predates regex rules, and a release of that era would match the
  // pattern as literal text. A version 1 file that claims one is mislabeled.
  if (
    parsed.version === LITERAL_HIGHLIGHT_PROFILE_VERSION &&
    parsed.profiles.some((profile) => profile.rules.some((rule) => rule.regex))
  ) {
    throw new Error(
      `This file contains regex rules, which need highlighting profile version ${HIGHLIGHT_PROFILE_VERSION}; it says version ${LITERAL_HIGHLIGHT_PROFILE_VERSION}.`,
    );
  }
  return {
    format: HIGHLIGHT_PROFILE_FORMAT,
    version: parsed.version,
    createdAt: parsed.createdAt,
    profiles: parsed.profiles.map(copyProfile),
  };
}

/** Replace matching IDs and retain unrelated profiles during an import. */
export function mergeHighlightProfiles(
  current: readonly KeywordHighlightProfile[],
  imported: readonly KeywordHighlightProfile[],
): KeywordHighlightProfile[] {
  const byId = new Map(current.map((profile) => [profile.id, profile]));
  for (const profile of imported) byId.set(profile.id, profile);
  if (byId.size > MAX_KEYWORD_HIGHLIGHT_PROFILES) {
    throw new Error(
      `This import would exceed the limit of ${MAX_KEYWORD_HIGHLIGHT_PROFILES} highlighting profiles. Delete an existing profile and try again.`,
    );
  }
  const merged = [...byId.values()];
  if (!isKeywordHighlightProfileArray(merged)) {
    throw new Error('The merged highlighting profiles are invalid.');
  }
  return merged;
}

export function isKeywordHighlightProfileArray(
  value: unknown,
): value is KeywordHighlightProfile[] {
  if (!Array.isArray(value) || value.length > MAX_KEYWORD_HIGHLIGHT_PROFILES) return false;
  const profileIds = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (
      !boundedString(entry.id, 200) ||
      profileIds.has(entry.id) ||
      !boundedString(entry.name, 200) ||
      !entry.name.trim() ||
      !Array.isArray(entry.rules) ||
      entry.rules.length > MAX_KEYWORD_HIGHLIGHT_RULES
    ) {
      return false;
    }
    const ruleIds = new Set<string>();
    if (
      !entry.rules.every((rule) => {
        if (!validKeywordHighlightRule(rule) || ruleIds.has(rule.id)) return false;
        ruleIds.add(rule.id);
        return true;
      })
    ) {
      return false;
    }
    profileIds.add(entry.id);
    return true;
  });
}

export function validKeywordHighlightRule(value: unknown): value is KeywordHighlightRule {
  return (
    isRecord(value) &&
    boundedString(value.id, 100) &&
    (value.name === undefined || boundedString(value.name, 100)) &&
    boundedString(value.keyword, 500) &&
    validHexColor(value.foreground) &&
    (value.background === undefined || validHexColor(value.background)) &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.wholeWord === 'boolean' &&
    (value.regex === undefined || typeof value.regex === 'boolean')
  );
}

/** Rules as the JSON editor shows them: no IDs, fields in reading order. */
export function keywordHighlightRulesToJson(rules: readonly KeywordHighlightRule[]): string {
  return JSON.stringify(
    rules.map((rule) => ({
      ...(rule.name ? { name: rule.name } : {}),
      keyword: rule.keyword,
      regex: !!rule.regex,
      caseSensitive: rule.caseSensitive,
      wholeWord: rule.wholeWord,
      foreground: rule.foreground,
      ...(rule.background ? { background: rule.background } : {}),
    })),
    null,
    2,
  );
}

const JSON_RULE_FIELDS = new Set([
  'id',
  'name',
  'keyword',
  'regex',
  'caseSensitive',
  'wholeWord',
  'foreground',
  'background',
]);

/**
 * Parse rules edited as JSON. Flags default to false and IDs are optional: an
 * entry without one keeps the ID of the rule at its position, so rules pasted
 * from an exported profile file work as well as hand-written ones. Throws an
 * Error naming the first problem and its 1-based rule number.
 */
export function parseKeywordHighlightRulesJson(
  text: string,
  previous: readonly KeywordHighlightRule[],
): KeywordHighlightRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `This is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rules: [ { ... } ].');
  if (parsed.length > MAX_KEYWORD_HIGHLIGHT_RULES) {
    throw new Error(`A rule list holds at most ${MAX_KEYWORD_HIGHLIGHT_RULES} rules.`);
  }
  const explicitIds = new Set<string>();
  const entries = parsed.map((entry, index) => {
    const label = `Rule ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    const unknown = Object.keys(entry).find((key) => !JSON_RULE_FIELDS.has(key));
    if (unknown) throw new Error(`${label} has an unknown field "${unknown}".`);
    if (entry.id !== undefined) {
      if (!boundedString(entry.id, 100) || explicitIds.has(entry.id)) {
        throw new Error(`${label} needs a unique "id" of up to 100 characters, or none.`);
      }
      explicitIds.add(entry.id);
    }
    return { entry, label };
  });
  const usedIds = new Set(explicitIds);
  return entries.map(({ entry, label }, index) => {
    if (!boundedString(entry.keyword, 500)) {
      throw new Error(`${label} needs a "keyword" of 1 to 500 characters.`);
    }
    if (entry.name !== undefined && entry.name !== '' && !boundedString(entry.name, 100)) {
      throw new Error(`${label}: "name" must be text of up to 100 characters.`);
    }
    if (!validHexColor(entry.foreground)) {
      throw new Error(`${label}: "foreground" must be a color such as "#ff0000".`);
    }
    if (entry.background != null && !validHexColor(entry.background)) {
      throw new Error(`${label}: "background" must be a color such as "#7f1d1d", or left out.`);
    }
    for (const flag of ['regex', 'caseSensitive', 'wholeWord'] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        throw new Error(`${label}: "${flag}" must be true or false.`);
      }
    }
    let id = typeof entry.id === 'string' ? entry.id : previous[index]?.id;
    if (id === undefined || (entry.id === undefined && usedIds.has(id))) {
      id = newPreferenceId('highlight');
    }
    usedIds.add(id);
    const rule: KeywordHighlightRule = {
      id,
      ...(entry.name ? { name: entry.name as string } : {}),
      keyword: entry.keyword,
      foreground: entry.foreground,
      ...(entry.background ? { background: entry.background as string } : {}),
      caseSensitive: entry.caseSensitive === true,
      wholeWord: entry.wholeWord === true,
      ...(entry.regex === true ? { regex: true } : {}),
    };
    const patternError = keywordPatternError(rule);
    if (patternError) throw new Error(`${label}: ${patternError}`);
    return rule;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** Strip unknown JSON fields instead of carrying them into preferences and later exports. */
function copyProfile(profile: KeywordHighlightProfile): KeywordHighlightProfile {
  return {
    id: profile.id,
    name: profile.name,
    rules: profile.rules.map((rule) => ({
      id: rule.id,
      ...(rule.name === undefined ? {} : { name: rule.name }),
      keyword: rule.keyword,
      foreground: rule.foreground,
      ...(rule.background === undefined ? {} : { background: rule.background }),
      caseSensitive: rule.caseSensitive,
      wholeWord: rule.wholeWord,
      ...(rule.regex ? { regex: true } : {}),
    })),
  };
}
