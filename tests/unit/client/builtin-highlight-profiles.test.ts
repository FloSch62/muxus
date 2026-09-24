import { describe, expect, it } from 'vitest';
import type { KeywordHighlightProfile } from '@muxus/shared';
import {
  BUILTIN_HIGHLIGHT_PROFILES,
  NOKIA_SRLINUX_HIGHLIGHT_PROFILE,
  NOKIA_SROS_HIGHLIGHT_PROFILE,
  withBuiltinHighlightProfiles,
  withBuiltinRuleNames,
} from '../../../client/src/builtin-highlight-profiles.js';
import {
  MAX_KEYWORD_HIGHLIGHT_PROFILES,
  createHighlightProfileDocument,
  isKeywordHighlightProfileArray,
  parseHighlightProfileDocument,
} from '../../../client/src/highlight-profiles.js';
import {
  findKeywordMatches,
  keywordHighlightRulesProblem,
} from '../../../client/src/terminal/keyword-highlighting.js';

/** [rule id, matched text] pairs, in the order decorations would be drawn. */
function highlights(profile: KeywordHighlightProfile, line: string): [string, string][] {
  return findKeywordMatches(line, profile.rules).map((match) => [
    match.rule.id,
    line.slice(match.start, match.end),
  ]);
}

describe('built-in highlighting profiles', () => {
  it('are valid, compilable, and survive an export/import round trip', () => {
    expect(isKeywordHighlightProfileArray(BUILTIN_HIGHLIGHT_PROFILES)).toBe(true);
    for (const profile of BUILTIN_HIGHLIGHT_PROFILES) {
      expect(keywordHighlightRulesProblem(profile.rules)).toBeNull();
      // A name says what each regex is for; the patterns alone are hard to read.
      const names = profile.rules.map((rule) => rule.name);
      expect(names.every(Boolean)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
    const document = createHighlightProfileDocument([...BUILTIN_HIGHLIGHT_PROFILES]);
    expect(document.version).toBe(2);
    expect(parseHighlightProfileDocument(JSON.stringify(document)).profiles).toEqual(
      BUILTIN_HIGHLIGHT_PROFILES,
    );
  });

  it('mark addresses without catching timestamps, dates, or OIDs', () => {
    const sros = NOKIA_SROS_HIGHLIGHT_PROFILE;
    expect(highlights(sros, '   10.1.2.1/31      fe80::1/64   2001:db8::1:2')).toEqual([
      ['ipv4', '10.1.2.1/31'],
      ['ipv6', 'fe80::1/64'],
      ['ipv6', '2001:db8::1:2'],
    ]);
    expect(highlights(sros, 'Hardware Address  : 1A:2B:3C:4D:5E:6F')).toEqual([
      ['mac', '1A:2B:3C:4D:5E:6F'],
    ]);
    expect(highlights(sros, '::ffff:10.0.0.1')).toEqual([['ipv4', '10.0.0.1']]);
    expect(highlights(sros, '2024/01/01 12:00:00.000 UTC 1.3.6.1.4.1 TiMOS-C-23.10.R1')).toEqual(
      [],
    );
  });

  it('highlight SR OS tables, logs, and MD-CLI context', () => {
    const sros = NOKIA_SROS_HIGHLIGHT_PROFILE;
    expect(
      highlights(sros, 'to-pe2                           Up        Up/Down     Network 1/1/c1/1:0'),
    ).toEqual([
      ['port', '1/1/c1/1'],
      ['state-up', 'Up'],
      ['state-up', 'Up'],
      ['state-down', 'Down'],
    ]);
    expect(highlights(sros, '1/1/c2        Down       Down          conn   lag-10')).toEqual([
      ['port', '1/1/c2'],
      ['port', 'lag-10'],
      ['state-down', 'Down'],
      ['state-down', 'Down'],
    ]);
    expect(highlights(sros, '                65000       0    0 00h05m12s Connect')).toEqual([
      ['bgp-transitional', 'Connect'],
    ]);
    expect(
      highlights(
        sros,
        '12 2024/01/01 12:00:00.000 UTC MAJOR: BGP #2002 Base "Peer 1: 10.0.0.2: moved from higher state ESTABLISHED to lower state IDLE"',
      ),
    ).toEqual([
      ['ipv4', '10.0.0.2'],
      ['state-up', 'ESTABLISHED'],
      ['bgp-transitional', 'IDLE'],
      ['severity-major', 'MAJOR'],
    ]);
    expect(highlights(sros, 'MINOR: MGMT_CORE #2201: Unknown element - "foo"')).toEqual([
      ['severity-minor', 'MINOR'],
    ]);
    expect(highlights(sros, 'Error: Bad command.')).toEqual([['cli-error', 'Error: Bad command.']]);
    expect(highlights(sros, '*(ex)[/configure router "Base" interface "to-pe2"]')).toEqual([
      ['mdcli-config-mode', '*(ex)'],
    ]);
    expect(highlights(sros, '[/]')).toEqual([]);
  });

  it('distinguish SR OS administrative shutdown from its negation', () => {
    const sros = NOKIA_SROS_HIGHLIGHT_PROFILE;
    expect(highlights(sros, '            shutdown')).toEqual([['state-admin-down', 'shutdown']]);
    expect(highlights(sros, '            no shutdown')).toEqual([]);
    expect(highlights(sros, '        admin-state disable')).toEqual([
      ['state-admin-down', 'disable'],
    ]);
  });

  it('highlight SR Linux tables, prompts, and commit results', () => {
    const srl = NOKIA_SRLINUX_HIGHLIGHT_PROFILE;
    expect(highlights(srl, '| ethernet-1/1        | enable      | up          | 25G   |')).toEqual([
      ['interface', 'ethernet-1/1'],
      ['state-up', 'enable'],
      ['state-up', 'up'],
    ]);
    expect(highlights(srl, '| ethernet-1/3        | disable     | down        | 25G   |')).toEqual([
      ['interface', 'ethernet-1/3'],
      ['state-admin-down', 'disable'],
      ['state-down', 'down'],
    ]);
    expect(
      highlights(srl, '| default  | 10.0.0.3 | ebgp | S | 65003 | active | ipv4-unicast | mgmt0.0 |'),
    ).toEqual([
      ['ipv4', '10.0.0.3'],
      ['interface', 'mgmt0.0'],
      ['bgp-transitional', 'active'],
    ]);
    expect(
      highlights(srl, '--{ + candidate shared default }--[ interface ethernet-1/1 ]--'),
    ).toEqual([
      ['interface', 'ethernet-1/1'],
      ['prompt-context', '--{ + candidate shared default }--[ interface ethernet-1/1 ]--'],
      ['prompt-candidate', '--{ + candidate shared default }--'],
    ]);
    expect(highlights(srl, 'All changes have been committed. Leaving candidate mode.')).toEqual([
      ['commit-ok', 'All changes have been committed'],
    ]);
    expect(highlights(srl, "Error: Path '/interface[name=foo]' is not valid")).toEqual([
      ['cli-error', "Error: Path '/interface[name=foo]' is not valid"],
    ]);
  });

  it('leave SR Linux YANG leaf names and table headers alone', () => {
    const srl = NOKIA_SRLINUX_HIGHLIGHT_PROFILE;
    expect(highlights(srl, '    oper-down-reason port-admin-disabled')).toEqual([]);
    expect(highlights(srl, '| Net-Inst | Peer | State | Uptime | AFI/SAFI | [Rx/Active/Tx] |')).toEqual(
      [],
    );
  });
});

describe('withBuiltinHighlightProfiles', () => {
  const custom: KeywordHighlightProfile = { id: 'custom', name: 'Custom', rules: [] };

  it('appends missing built-ins after existing profiles', () => {
    expect(withBuiltinHighlightProfiles([custom]).map((profile) => profile.id)).toEqual([
      'custom',
      'muxus-nokia-sros',
      'muxus-nokia-srlinux',
    ]);
  });

  it('keeps an installed copy, including the user’s edits', () => {
    const edited = { ...NOKIA_SROS_HIGHLIGHT_PROFILE, name: 'My SR OS', rules: [] };
    expect(withBuiltinHighlightProfiles([edited])).toEqual([
      edited,
      NOKIA_SRLINUX_HIGHLIGHT_PROFILE,
    ]);
  });

  it('never exceeds the profile limit', () => {
    const full = Array.from({ length: MAX_KEYWORD_HIGHLIGHT_PROFILES - 1 }, (_, index) => ({
      ...custom,
      id: `custom-${index}`,
    }));
    expect(withBuiltinHighlightProfiles(full)).toHaveLength(MAX_KEYWORD_HIGHLIGHT_PROFILES);
  });
});

describe('withBuiltinRuleNames', () => {
  const unnamed = (profile: KeywordHighlightProfile): KeywordHighlightProfile => ({
    ...profile,
    rules: profile.rules.map(({ name: _name, ...rule }) => rule),
  });

  it('restores the shipped names on rules seeded without them', () => {
    expect(
      withBuiltinRuleNames([unnamed(NOKIA_SROS_HIGHLIGHT_PROFILE), unnamed(NOKIA_SRLINUX_HIGHLIGHT_PROFILE)]),
    ).toEqual(BUILTIN_HIGHLIGHT_PROFILES);
  });

  it('keeps user names, changed patterns, added rules, and other profiles', () => {
    const [ipv4, ipv6, ...rest] = unnamed(NOKIA_SROS_HIGHLIGHT_PROFILE).rules;
    const added = { ...ipv4!, id: 'mine', keyword: 'LAB' };
    const edited: KeywordHighlightProfile = {
      ...NOKIA_SROS_HIGHLIGHT_PROFILE,
      rules: [{ ...ipv4!, name: 'Loopbacks' }, { ...ipv6!, keyword: 'fe80::' }, added, ...rest],
    };
    const custom: KeywordHighlightProfile = { id: 'custom', name: 'Custom', rules: [added] };
    const [sros, other] = withBuiltinRuleNames([edited, custom]);

    expect(sros!.rules.slice(0, 3).map((rule) => rule.name)).toEqual([
      'Loopbacks',
      undefined,
      undefined,
    ]);
    expect(sros!.rules[3]!.name).toBe('MAC addresses');
    expect(other).toBe(custom);
  });
});
