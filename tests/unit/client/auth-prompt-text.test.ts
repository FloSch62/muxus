import { describe, expect, it } from 'vitest';
import { authPromptText } from '../../../client/src/auth-prompt-text.js';

describe('sign-in prompt text', () => {
  it('labels the field with a one-line prompt, without its colon', () => {
    expect(authPromptText('Verification code: ')).toEqual({ label: 'Verification code' });
    expect(authPromptText("admin@core's password")).toEqual({ label: "admin@core's password" });
  });

  it('keeps a menu sent ahead of the question readable above the field', () => {
    const prompt = [
      'Duo two-factor login for admin',
      '',
      'Enter a passcode or select one of the following options:',
      '',
      ' 1. Duo Push to XXX-XXX-0130',
      ' 2. Phone call to XXX-XXX-0130',
      '',
      'Passcode or option (1-2): ',
    ].join('\n');

    expect(authPromptText(prompt)).toEqual({
      label: 'Passcode or option (1-2)',
      text: [
        'Duo two-factor login for admin',
        '',
        'Enter a passcode or select one of the following options:',
        '',
        ' 1. Duo Push to XXX-XXX-0130',
        ' 2. Phone call to XXX-XXX-0130',
      ].join('\n'),
    });
  });

  it('ignores blank lines around the prompt and carriage returns', () => {
    expect(authPromptText('\r\n\r\nBanner line\r\nToken: \r\n')).toEqual({
      label: 'Token',
      text: 'Banner line',
    });
    expect(authPromptText('\n\nToken: \n')).toEqual({ label: 'Token' });
  });
});
