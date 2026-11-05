import { describe, expect, it } from 'vitest';
import { terminalSchemeGroups } from '../../../client/src/components/TerminalSchemeSelect.js';
import { TERMINAL_SCHEMES } from '../../../client/src/terminal/palette.js';

const labels = (groups: ReadonlyArray<{ label: string }>) => groups.map((group) => group.label);

describe('terminalSchemeGroups', () => {
  it('lists light schemes first by default', () => {
    expect(labels(terminalSchemeGroups([]))).toEqual(['Light schemes', 'Dark schemes']);
  });

  it('lists dark schemes first for a dark picker', () => {
    const groups = terminalSchemeGroups([], 'dark');
    expect(labels(groups)).toEqual(['Dark schemes', 'Light schemes']);
    expect(groups[0]?.schemes.every((scheme) => !scheme.light)).toBe(true);
    expect(groups[1]?.schemes.every((scheme) => scheme.light)).toBe(true);
  });

  it("keeps the user's own schemes ahead of the built-ins", () => {
    const custom = [TERMINAL_SCHEMES[0]!];
    expect(labels(terminalSchemeGroups(custom, 'dark'))).toEqual([
      'Custom schemes',
      'Dark schemes',
      'Light schemes',
    ]);
  });
});
