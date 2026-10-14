import { describe, expect, it } from 'vitest';
import {
  antiIdleDraft,
  antiIdleFromDraft,
  antiIdleProblem,
  isAntiIdle,
  sameAntiIdleDraft,
} from '../../../client/src/anti-idle.js';

describe('anti-idle drafts', () => {
  it('starts off, with no Enter, and round-trips a stored setting', () => {
    const blank = antiIdleDraft(undefined);
    expect(blank).toEqual({ enabled: false, intervalSeconds: '60', text: '', enter: false });
    expect(antiIdleFromDraft(blank)).toBeNull();
    expect(antiIdleProblem(blank)).toBeNull();

    const stored = { intervalSeconds: 300, text: ' ', enter: false };
    expect(antiIdleDraft(stored)).toEqual({
      enabled: true,
      intervalSeconds: '300',
      text: ' ',
      enter: false,
    });
    expect(antiIdleFromDraft(antiIdleDraft(stored))).toEqual(stored);
  });

  it('turns off without losing what was typed', () => {
    const draft = { enabled: false, intervalSeconds: '90', text: 'show clock', enter: true };
    expect(antiIdleFromDraft(draft)).toBeNull();
    expect(antiIdleFromDraft({ ...draft, enabled: true })).toEqual({
      intervalSeconds: 90,
      text: 'show clock',
      enter: true,
    });
  });

  it('names what stops a draft from saving', () => {
    const draft = { enabled: true, intervalSeconds: '60', text: ' ', enter: false };
    expect(antiIdleProblem(draft)).toBeNull();
    expect(antiIdleProblem({ ...draft, intervalSeconds: '' })).toBe(
      'Anti-idle interval: Between 10 and 3600 seconds.',
    );
    expect(antiIdleProblem({ ...draft, intervalSeconds: '9' })).toMatch(/^Anti-idle interval/);
    expect(antiIdleProblem({ ...draft, intervalSeconds: '3601' })).toMatch(/^Anti-idle interval/);
    expect(antiIdleProblem({ ...draft, intervalSeconds: '3600' })).toBeNull();
    expect(antiIdleProblem({ ...draft, text: '' })).toBe('Anti-idle: enter text to type, or press Enter.');
    expect(antiIdleProblem({ ...draft, text: '', enter: true })).toBeNull();
    expect(antiIdleProblem({ ...draft, text: 'x'.repeat(257) })).toMatch(/up to 256 characters/);
    expect(antiIdleProblem({ ...draft, text: 'show\tclock' })).toBe(
      'Anti-idle text cannot contain control characters.',
    );
    expect(antiIdleProblem({ ...draft, text: 'a\rb\u0003' })).toBe(
      'Anti-idle text cannot contain control characters.',
    );
  });

  it('compares what would be stored', () => {
    const on = { enabled: true, intervalSeconds: '60', text: ' ', enter: false };
    expect(sameAntiIdleDraft(on, { ...on })).toBe(true);
    expect(sameAntiIdleDraft(on, { ...on, enter: true })).toBe(false);
    expect(
      sameAntiIdleDraft({ ...on, enabled: false }, { enabled: false, intervalSeconds: '10', text: '', enter: true }),
    ).toBe(true);
  });

  it('accepts only valid settings from a backup', () => {
    expect(isAntiIdle({ intervalSeconds: 60, text: ' ', enter: false })).toBe(true);
    expect(isAntiIdle({ intervalSeconds: 60, text: '', enter: true })).toBe(true);
    expect(isAntiIdle(undefined)).toBe(false);
    expect(isAntiIdle({ intervalSeconds: 5, text: ' ', enter: false })).toBe(false);
    expect(isAntiIdle({ intervalSeconds: 60.5, text: ' ', enter: false })).toBe(false);
    expect(isAntiIdle({ intervalSeconds: 60, text: '', enter: false })).toBe(false);
    expect(isAntiIdle({ intervalSeconds: '60', text: ' ', enter: false })).toBe(false);
    expect(isAntiIdle({ intervalSeconds: 60, text: 'a\rb\u0003', enter: false })).toBe(false);
    expect(isAntiIdle([60, ' ', false])).toBe(false);
  });
});
