import { describe, expect, it } from 'vitest';
import {
  isQuickLauncherShortcut,
  selectQuickLauncherItems,
  type QuickLauncherItem,
} from '../../../client/src/quick-launcher.js';

const item = (
  id: string,
  label: string,
  options: Partial<QuickLauncherItem> = {},
): QuickLauncherItem => ({
  id,
  kind: 'host',
  label,
  detail: '',
  priority: 0,
  showWhenEmpty: false,
  ...options,
});

describe('quick launcher search', () => {
  it('shows only intentional initial suggestions ordered by priority', () => {
    const results = selectQuickLauncherItems([
      item('hidden', 'Hidden', { priority: 100 }),
      item('recent', 'Recent', { priority: 20, showWhenEmpty: true }),
      item('live', 'Live', { priority: 200, showWhenEmpty: true }),
    ], '');

    expect(results.map((result) => result.id)).toEqual(['live', 'recent']);
  });

  it('matches every query token across labels, details, and keywords', () => {
    const results = selectQuickLauncherItems([
      item('prod', 'Core router', {
        detail: 'Production · admin@router.example.test',
        keywords: ['ssh'],
      }),
      item('lab', 'Lab router', {
        detail: 'Lab · operator@router.example.test',
        keywords: ['ssh'],
      }),
    ], 'prod ssh');

    expect(results.map((result) => result.id)).toEqual(['prod']);
  });

  it('ranks exact and prefix label matches above metadata-only matches', () => {
    const results = selectQuickLauncherItems([
      item('metadata', 'Production database', {
        detail: 'Alias: core',
        priority: 100,
      }),
      item('prefix', 'Core router'),
      item('exact', 'core'),
    ], 'core');

    expect(results.map((result) => result.id)).toEqual([
      'exact',
      'prefix',
      'metadata',
    ]);
  });

  it('preserves stable order for equally ranked results and applies the limit', () => {
    const results = selectQuickLauncherItems([
      item('one', 'One match'),
      item('two', 'Two match'),
      item('three', 'Three match'),
    ], 'match', 2);

    expect(results.map((result) => result.id)).toEqual(['one', 'two']);
  });
});

describe('quick launcher shortcut', () => {
  it('accepts Ctrl+K and Cmd+K without conflicting modifiers', () => {
    const chord = {
      code: 'KeyK',
      altKey: false,
      shiftKey: false,
    };

    expect(isQuickLauncherShortcut({ ...chord, ctrlKey: true, metaKey: false })).toBe(true);
    expect(isQuickLauncherShortcut({ ...chord, ctrlKey: false, metaKey: true })).toBe(true);
    expect(
      isQuickLauncherShortcut({
        ...chord,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });
});
