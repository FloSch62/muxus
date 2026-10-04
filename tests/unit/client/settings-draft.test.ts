import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SESSION_LOGGING_POLICY,
  sameSessionLoggingDraft,
  type HostSessionLoggingDraft,
} from '../../../client/src/session-logging-policy.js';
import { followStoredDraft } from '../../../client/src/settings-draft.js';

const same = (a: { value: string }, b: { value: string }) => a.value.trim() === b.value.trim();

describe('settings drafts', () => {
  it('starts from the first stored value', () => {
    expect(followStoredDraft({ value: 'initial' }, undefined, { value: 'stored' }, false, same))
      .toEqual({ value: 'stored' });
  });

  it('follows a refetch while the draft holds no edits, in any spacing', () => {
    expect(
      followStoredDraft({ value: ' old ' }, { value: 'old' }, { value: 'new' }, false, same),
    ).toEqual({ value: 'new' });
  });

  it('keeps unsaved edits across a refetch', () => {
    expect(
      followStoredDraft({ value: 'edited' }, { value: 'old' }, { value: 'new' }, false, same),
    ).toEqual({ value: 'edited' });
  });

  it('takes what the server kept right after a save', () => {
    expect(
      followStoredDraft({ value: 'Edited ' }, { value: 'old' }, { value: 'edited' }, true, same),
    ).toEqual({ value: 'edited' });
  });
});

describe('session logging policy drafts', () => {
  const draft = (patch: Partial<HostSessionLoggingDraft> = {}): HostSessionLoggingDraft => ({
    ...FALLBACK_SESSION_LOGGING_POLICY,
    inherit: false,
    loaded: true,
    ...patch,
  });

  it('counts every saved field and ignores the loading flag', () => {
    expect(sameSessionLoggingDraft(draft(), draft({ loaded: false }))).toBe(true);
    expect(sameSessionLoggingDraft(draft(), draft({ logToFile: true }))).toBe(false);
    expect(sameSessionLoggingDraft(draft(), draft({ maxParts: 3 }))).toBe(false);
  });

  it('treats inherited drafts as equal whatever their fields show', () => {
    expect(
      sameSessionLoggingDraft(draft({ inherit: true }), draft({ inherit: true, enabled: true })),
    ).toBe(true);
    expect(sameSessionLoggingDraft(draft({ inherit: true }), draft())).toBe(false);
  });
});
