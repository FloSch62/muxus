import { describe, expect, it } from 'vitest';
import type { FolderSettingsRecord, LoginSequence, LoginSequenceStep } from '@muxus/shared';
import {
  changeLoginStepKind,
  inheritedLoginSequence,
  isLoginSequence,
  loginSequenceDraft,
  loginSequenceFromDraft,
  loginSequenceProblem,
  loginSequencesUsingSecret,
  loginStepSummary,
  moveLoginStep,
  newLoginStep,
  sameLoginSequence,
} from '../../../client/src/login-sequence.js';

const wait: LoginSequenceStep = { id: 'w', kind: 'wait', pattern: 'Password:', timeoutSeconds: 10 };
const send: LoginSequenceStep = { id: 's', kind: 'send', text: 'enable', enter: true };
const secret: LoginSequenceStep = { id: 'k', kind: 'secret', secretId: 'vault-1', enter: true };

function folder(path: string, loginSequence?: LoginSequence): FolderSettingsRecord {
  return {
    id: path,
    path,
    auth: {},
    hasPassword: false,
    ...(loginSequence ? { loginSequence } : {}),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('login sequence drafts', () => {
  it('maps the stored form to a mode and back', () => {
    expect(loginSequenceDraft(undefined)).toEqual({ mode: 'inherit', steps: [] });
    expect(loginSequenceDraft({ steps: [] })).toEqual({ mode: 'none', steps: [] });
    expect(loginSequenceDraft({ steps: [wait, send] })).toEqual({ mode: 'custom', steps: [wait, send] });

    expect(loginSequenceFromDraft({ mode: 'inherit', steps: [wait] })).toBeNull();
    expect(loginSequenceFromDraft({ mode: 'none', steps: [wait] })).toEqual({ steps: [] });
    expect(loginSequenceFromDraft({ mode: 'custom', steps: [wait] })).toEqual({ steps: [wait] });
  });

  it('starts new steps with sensible defaults and unique ids', () => {
    const a = newLoginStep('wait');
    const b = newLoginStep('wait');
    expect(a).toMatchObject({ kind: 'wait', pattern: '', timeoutSeconds: 10 });
    expect(a.id).not.toBe(b.id);
    expect(newLoginStep('send')).toMatchObject({ kind: 'send', text: '', enter: true });
    expect(newLoginStep('secret')).toMatchObject({ kind: 'secret', secretId: '', enter: true });
  });

  it('keeps the id and the text when a step changes kind', () => {
    expect(changeLoginStepKind(wait, 'send')).toMatchObject({ id: 'w', kind: 'send', text: 'Password:' });
    expect(changeLoginStepKind(send, 'wait')).toMatchObject({ id: 's', kind: 'wait', pattern: 'enable' });
    expect(changeLoginStepKind(send, 'secret')).toMatchObject({ id: 's', kind: 'secret', secretId: '' });
    expect(changeLoginStepKind(send, 'send')).toBe(send);
  });

  it('reorders steps and ignores moves past either end', () => {
    expect(moveLoginStep([wait, send, secret], 0, 1).map((step) => step.id)).toEqual(['s', 'w', 'k']);
    expect(moveLoginStep([wait, send, secret], 2, -1).map((step) => step.id)).toEqual(['w', 'k', 's']);
    expect(moveLoginStep([wait, send], 0, -1).map((step) => step.id)).toEqual(['w', 's']);
    expect(moveLoginStep([wait, send], 1, 1).map((step) => step.id)).toEqual(['w', 's']);
  });
});

describe('loginSequenceProblem', () => {
  it.each<[LoginSequenceStep, string | null]>([
    [wait, null],
    [{ ...wait, pattern: '' }, 'Login sequence step 1: Enter the text to wait for.'],
    [{ ...wait, pattern: '(', regex: true }, expect.stringContaining('Invalid regular expression') as never],
    // Literal text is never compiled, so regex syntax there is fine.
    [{ ...wait, pattern: '(' }, null],
    [{ ...wait, timeoutSeconds: 0 }, 'Login sequence step 1: Wait between 1 and 3600 seconds.'],
    [{ ...wait, timeoutSeconds: 3601 }, 'Login sequence step 1: Wait between 1 and 3600 seconds.'],
    [{ ...send, text: '', enter: true }, null],
    [{ ...send, text: '', enter: false }, 'Login sequence step 1: Enter text to send, or press Enter.'],
    [{ ...secret, secretId: '' }, 'Login sequence step 1: Choose a secret from the password vault.'],
  ])('%o', (step, problem) => {
    expect(loginSequenceProblem({ mode: 'custom', steps: [step] })).toEqual(problem);
  });

  it('only checks a draft that runs its own steps', () => {
    const broken = [{ ...wait, pattern: '' }];
    expect(loginSequenceProblem({ mode: 'inherit', steps: broken })).toBeNull();
    expect(loginSequenceProblem({ mode: 'none', steps: broken })).toBeNull();
    expect(loginSequenceProblem({ mode: 'custom', steps: [] })).toMatch(/Add a login step/);
    expect(
      loginSequenceProblem({ mode: 'custom', steps: Array.from({ length: 33 }, () => newLoginStep('send')) }),
    ).toMatch(/up to 32 steps/);
  });
});

describe('sameLoginSequence', () => {
  it('ignores step ids and an unset regex flag', () => {
    expect(sameLoginSequence({ steps: [wait] }, { steps: [{ ...wait, id: 'other', regex: false }] })).toBe(true);
    expect(sameLoginSequence({ steps: [wait] }, { steps: [{ ...wait, pattern: 'login:' }] })).toBe(false);
    expect(sameLoginSequence(null, undefined)).toBe(true);
    expect(sameLoginSequence(null, { steps: [] })).toBe(false);
  });
});

describe('inheritedLoginSequence', () => {
  const folders = [
    folder('Network', { steps: [send] }),
    folder('network/consoles', { steps: [wait] }),
    folder('Network/Lab', { steps: [] }),
    folder('Servers'),
  ];

  it('takes the nearest folder that sets a sequence', () => {
    expect(inheritedLoginSequence(folders, 'Network/Consoles')).toEqual({
      sequence: { steps: [wait] },
      folder: 'network/consoles',
    });
    expect(inheritedLoginSequence(folders, 'Network / EU / Edge')).toEqual({
      sequence: { steps: [send] },
      folder: 'Network',
    });
  });

  it('stops at a folder that switches it off, and finds nothing outside', () => {
    expect(inheritedLoginSequence(folders, 'Network/Lab/Bench')).toBeUndefined();
    expect(inheritedLoginSequence(folders, 'Servers')).toBeUndefined();
    expect(inheritedLoginSequence(folders, '')).toBeUndefined();
    expect(inheritedLoginSequence(undefined, 'Network')).toBeUndefined();
  });
});

describe('isLoginSequence', () => {
  it('accepts well-formed sequences only', () => {
    expect(isLoginSequence({ steps: [wait, send, secret] })).toBe(true);
    expect(isLoginSequence({ steps: [] })).toBe(true);
    expect(isLoginSequence(undefined)).toBe(false);
    expect(isLoginSequence({ steps: 'nope' })).toBe(false);
    expect(isLoginSequence({ steps: [{ ...wait, kind: 'type' }] })).toBe(false);
    expect(isLoginSequence({ steps: [{ ...wait, pattern: '(', regex: true }] })).toBe(false);
    expect(isLoginSequence({ steps: [{ ...send, id: '' }] })).toBe(false);
  });
});

describe('loginStepSummary', () => {
  it('describes each kind of step', () => {
    expect(loginStepSummary(wait)).toBe('Wait for “Password:”');
    expect(loginStepSummary({ ...wait, pattern: '#\\s*$', regex: true })).toBe('Wait for a match of /#\\s*$/');
    expect(loginStepSummary(send)).toBe('Send “enable” and Enter');
    expect(loginStepSummary({ ...send, text: '' })).toBe('Press Enter');
    expect(loginStepSummary(secret, 'Core enable')).toBe('Send the secret “Core enable” and Enter');
    expect(loginStepSummary({ ...secret, enter: false })).toBe('Send the secret from the vault');
  });
});

describe('loginSequencesUsingSecret', () => {
  it('names the hosts and folders whose own sequence types the secret', () => {
    expect(
      loginSequencesUsingSecret(
        [
          { label: 'core-sw1', loginSequence: { steps: [wait, secret] } },
          { label: 'Network', loginSequence: { steps: [{ ...secret, secretId: 'other' }] } },
          { label: 'web-01' },
          { label: 'Lab', loginSequence: { steps: [secret] } },
        ],
        'vault-1',
      ),
    ).toEqual(['core-sw1', 'Lab']);
  });
});
