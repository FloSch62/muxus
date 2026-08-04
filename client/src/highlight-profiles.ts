import type { KeywordHighlightProfile, KeywordHighlightRule } from '@muxus/shared';

export const HIGHLIGHT_PROFILE_FORMAT = 'muxus-keyword-highlighting-profiles';
export const HIGHLIGHT_PROFILE_VERSION = 1;
export const MAX_HIGHLIGHT_PROFILE_FILE_BYTES = 2 * 1024 * 1024;

export interface HighlightProfileDocument {
  format: typeof HIGHLIGHT_PROFILE_FORMAT;
  version: typeof HIGHLIGHT_PROFILE_VERSION;
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
    version: HIGHLIGHT_PROFILE_VERSION,
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
  if (parsed.version !== HIGHLIGHT_PROFILE_VERSION) {
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
  return {
    format: HIGHLIGHT_PROFILE_FORMAT,
    version: HIGHLIGHT_PROFILE_VERSION,
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
  return [...byId.values()];
}

export function isKeywordHighlightProfileArray(
  value: unknown,
): value is KeywordHighlightProfile[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const profileIds = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (
      !boundedString(entry.id, 200) ||
      profileIds.has(entry.id) ||
      !boundedString(entry.name, 200) ||
      !entry.name.trim() ||
      !Array.isArray(entry.rules) ||
      entry.rules.length > 100
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
    boundedString(value.keyword, 500) &&
    validHexColor(value.foreground) &&
    (value.background === undefined || validHexColor(value.background)) &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.wholeWord === 'boolean'
  );
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
      keyword: rule.keyword,
      foreground: rule.foreground,
      ...(rule.background === undefined ? {} : { background: rule.background }),
      caseSensitive: rule.caseSensitive,
      wholeWord: rule.wholeWord,
    })),
  };
}
