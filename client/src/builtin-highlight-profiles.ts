import type { KeywordHighlightProfile, KeywordHighlightRule } from '@muxus/shared';
import { MAX_KEYWORD_HIGHLIGHT_PROFILES } from './highlight-profiles.js';

// Mid-tone text colors stay readable on both light and dark terminal schemes;
// severities use filled badges so they do not depend on the scheme at all.
const GREEN = '#16a34a';
const RED = '#dc2626';
const AMBER = '#d97706';
const BLUE = '#3b82f6';
const CYAN = '#0891b2';
const PURPLE = '#a855f7';

const R = String.raw;
const HEX_GROUP = R`[\da-f]{1,4}`;

type RuleOptions = Pick<KeywordHighlightRule, 'foreground'> &
  Partial<Omit<KeywordHighlightRule, 'id' | 'name' | 'keyword' | 'foreground'>>;

function pattern(
  id: string,
  name: string,
  keyword: string,
  options: RuleOptions,
): KeywordHighlightRule {
  return { id, name, keyword, caseSensitive: false, wholeWord: false, regex: true, ...options };
}

/** Address rules shared by both platforms; their IDs repeat across profiles. */
const addressRules: KeywordHighlightRule[] = [
  pattern('ipv4', 'IPv4 addresses', R`(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?(?!\.?\d)`, {
    foreground: CYAN,
  }),
  pattern(
    'ipv6',
    'IPv6 addresses',
    R`(?<![\w:])(?:(?:${HEX_GROUP}:){7}${HEX_GROUP}|(?:${HEX_GROUP}:){1,7}:(?:${HEX_GROUP}(?::${HEX_GROUP}){0,6})?|::(?:${HEX_GROUP}(?::${HEX_GROUP}){0,6})?)(?:/\d{1,3})?(?![\w:]|\.\d)`,
    { foreground: CYAN },
  ),
  pattern('mac', 'MAC addresses', R`\b[\da-f]{2}(?:[:-][\da-f]{2}){5}\b`, { foreground: PURPLE }),
];

// A hyphen counts as part of the word so YANG leaves such as oper-down-reason
// and hold-time up are not colored as states.
const state = (words: string) => R`(?<![\w-])(?:${words})(?![\w-])`;

const MAJOR_BADGE = { foreground: '#ffffff', background: '#b91c1c' };
const MINOR_BADGE = { foreground: '#1c1917', background: '#f59e0b' };

export const NOKIA_SROS_HIGHLIGHT_PROFILE: KeywordHighlightProfile = {
  id: 'muxus-nokia-sros',
  name: 'Nokia SR OS',
  rules: [
    ...addressRules,
    pattern(
      'port',
      'Ports and LAGs',
      R`\b\d{1,2}/\d{1,2}/(?:c\d{1,3}(?:/\d{1,3})?|\d{1,3})\b|\blag-\d+\b`,
      { foreground: BLUE },
    ),
    pattern('state-up', 'Up and enabled', state('up|established|inservice|enabled?'), {
      foreground: GREEN,
    }),
    pattern(
      'state-admin-down',
      'Administratively down',
      state('disabled?|ghost') + R`|(?<!no )\bshutdown\b`,
      { foreground: AMBER },
    ),
    pattern('state-down', 'Down and failed', state('down|outofservice|failed|failure'), {
      foreground: RED,
    }),
    pattern(
      'bgp-transitional',
      'BGP sessions not established',
      R`\b(?:Idle|Connect|OpenSent|OpenConfirm|IDLE|CONNECT|ACTIVE|OPENSENT|OPENCONFIRM)\b`,
      { foreground: AMBER, caseSensitive: true },
    ),
    pattern('severity-major', 'Critical and major alarms', R`\b(?:CRITICAL|MAJOR)\b`, {
      ...MAJOR_BADGE,
      caseSensitive: true,
    }),
    pattern('severity-minor', 'Minor alarms and warnings', R`\b(?:MINOR|WARNING)\b`, {
      ...MINOR_BADGE,
      caseSensitive: true,
    }),
    pattern('severity-cleared', 'Cleared alarms', R`\bCLEARED\b`, {
      foreground: '#ffffff',
      background: '#15803d',
      caseSensitive: true,
    }),
    pattern('severity-info', 'Info messages', R`\bINFO\b`, {
      foreground: BLUE,
      caseSensitive: true,
    }),
    pattern('cli-error', 'CLI errors', R`^Error:.*`, { foreground: RED, caseSensitive: true }),
    // The MD-CLI context line: "*(ex)[/configure]" means uncommitted changes
    // in an exclusive, private, global or read-only configuration session.
    pattern(
      'mdcli-config-mode',
      'MD-CLI configuration mode',
      R`^[!*]*\((?:ex|pr|gl|ro)\)(?=\[)`,
      { foreground: AMBER },
    ),
  ],
};

export const NOKIA_SRLINUX_HIGHLIGHT_PROFILE: KeywordHighlightProfile = {
  id: 'muxus-nokia-srlinux',
  name: 'Nokia SR Linux',
  rules: [
    ...addressRules,
    pattern(
      'interface',
      'Interfaces',
      R`\b(?:ethernet-\d+/\d+(?:/\d+)?|mgmt\d+|lag\d+|irb\d+|lo\d+|system\d+)(?:\.\d+)?\b`,
      { foreground: BLUE },
    ),
    pattern('state-up', 'Up and enabled', state('up|enabled?|established'), {
      foreground: GREEN,
    }),
    pattern('state-admin-down', 'Administratively down', state('disabled?'), {
      foreground: AMBER,
    }),
    pattern('state-down', 'Down and failed', state('down|failed|failure'), { foreground: RED }),
    // Lowercase only: table headers such as "Active" are not session states.
    pattern(
      'bgp-transitional',
      'BGP sessions not established',
      state('idle|active|connect|opensent|openconfirm'),
      { foreground: AMBER, caseSensitive: true },
    ),
    pattern('severity-major', 'Critical and major alarms', state('critical|major'), MAJOR_BADGE),
    pattern('severity-minor', 'Minor alarms and warnings', state('minor|warning'), MINOR_BADGE),
    pattern('cli-error', 'CLI errors', R`^Error:.*`, { foreground: RED, caseSensitive: true }),
    pattern('cli-warning', 'CLI warnings', R`^Warning:.*`, {
      foreground: AMBER,
      caseSensitive: true,
    }),
    {
      id: 'commit-ok',
      name: 'Commit succeeded',
      keyword: 'All changes have been committed',
      foreground: GREEN,
      caseSensitive: true,
      wholeWord: false,
    },
    // The context line above the prompt, e.g. "--{ + candidate shared default }--[  ]--".
    pattern('prompt-context', 'Prompt context', R`^--\{[^}]*\}--\[[^\]]*\]--`, {
      foreground: BLUE,
    }),
    pattern('prompt-candidate', 'Candidate mode', R`^--\{[^}]*\bcandidate\b[^}]*\}--`, {
      foreground: AMBER,
    }),
  ],
};

/** Profiles Muxus ships. They are ordinary, editable profiles with stable IDs. */
export const BUILTIN_HIGHLIGHT_PROFILES: readonly KeywordHighlightProfile[] = [
  NOKIA_SROS_HIGHLIGHT_PROFILE,
  NOKIA_SRLINUX_HIGHLIGHT_PROFILE,
];

/** Append each built-in profile that is not installed, within the profile limit. */
export function withBuiltinHighlightProfiles(
  profiles: readonly KeywordHighlightProfile[],
): KeywordHighlightProfile[] {
  const next = [...profiles];
  const installed = new Set(profiles.map((profile) => profile.id));
  for (const profile of BUILTIN_HIGHLIGHT_PROFILES) {
    if (next.length >= MAX_KEYWORD_HIGHLIGHT_PROFILES) break;
    if (!installed.has(profile.id)) next.push(profile);
  }
  return next;
}

/**
 * Name installed built-in rules that were seeded before they had names. Only a
 * rule that still has its shipped ID and pattern, and no name of its own, changes.
 */
export function withBuiltinRuleNames(
  profiles: readonly KeywordHighlightProfile[],
): KeywordHighlightProfile[] {
  return profiles.map((profile) => {
    const builtin = BUILTIN_HIGHLIGHT_PROFILES.find((candidate) => candidate.id === profile.id);
    if (!builtin) return profile;
    const shipped = new Map(builtin.rules.map((rule) => [rule.id, rule]));
    return {
      ...profile,
      rules: profile.rules.map((rule) => {
        const match = shipped.get(rule.id);
        return !rule.name && match?.name && match.keyword === rule.keyword
          ? { ...rule, name: match.name }
          : rule;
      }),
    };
  });
}
