import { describe, expect, it } from 'vitest';
import {
  isPastePromptWait,
  pastePromptTimeoutProblem,
  pastePromptWaitDraft,
  pastePromptWaitFromDraft,
  pastePromptWaitProblem,
  samePastePromptWaitDraft,
} from '../../../client/src/terminal/paste-prompt.js';

describe('prompt waiting drafts', () => {
  it('is off for a host without it, and stores only the fields that differ from the defaults', () => {
    const off = pastePromptWaitDraft(undefined);
    expect(off).toEqual({ enabled: false, promptPattern: '', timeoutMs: '', errorPattern: '' });
    expect(pastePromptWaitFromDraft(off)).toBeNull();
    expect(pastePromptWaitFromDraft({ ...off, enabled: true })).toEqual({});

    const own = { promptPattern: '[>#\\]]\\s*$', timeoutMs: 20_000, errorPattern: '^Error:' };
    const draft = pastePromptWaitDraft(own);
    expect(draft).toEqual({ enabled: true, ...own, timeoutMs: '20000' });
    expect(pastePromptWaitFromDraft(draft)).toEqual(own);
    // Switched off, the fields are kept for switching back but not saved.
    expect(pastePromptWaitFromDraft({ ...draft, enabled: false })).toBeNull();
    expect(samePastePromptWaitDraft({ ...draft, enabled: false }, off)).toBe(true);
    expect(samePastePromptWaitDraft(draft, off)).toBe(false);
  });

  it('names the field that keeps a draft from saving', () => {
    const on = pastePromptWaitDraft({});
    expect(pastePromptWaitProblem(on)).toBeNull();
    expect(pastePromptWaitProblem({ ...on, promptPattern: '[' })).toMatch(
      /^Prompt pattern: .*Invalid regular expression/,
    );
    expect(pastePromptWaitProblem({ ...on, errorPattern: '.*' })).toBe(
      'Error pattern: This pattern matches empty text, so it would match any output.',
    );
    expect(pastePromptWaitProblem({ ...on, timeoutMs: '70000' })).toBe(
      'Prompt timeout: Between 100 and 60000 ms.',
    );
    // A problem in a switched-off draft does not count.
    expect(pastePromptWaitProblem({ ...on, enabled: false, promptPattern: '[' })).toBeNull();
    expect(pastePromptTimeoutProblem('')).toBeUndefined();
    expect(pastePromptTimeoutProblem('100')).toBeUndefined();
  });

  it('checks a setting read from a backup', () => {
    expect(isPastePromptWait({})).toBe(true);
    expect(isPastePromptWait({ promptPattern: '#\\s*$', timeoutMs: 100, errorPattern: '^%' })).toBe(true);
    expect(isPastePromptWait(null)).toBe(false);
    expect(isPastePromptWait('[>#$]')).toBe(false);
    expect(isPastePromptWait({ promptPattern: 5 })).toBe(false);
    expect(isPastePromptWait({ errorPattern: '(' })).toBe(false);
    expect(isPastePromptWait({ timeoutMs: '5000' })).toBe(false);
  });
});
