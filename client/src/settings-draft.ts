import { useState } from 'react';

export interface SettingsDraft<T> {
  draft: T;
  /** The draft differs from the stored value, so undoing an edit clears it. */
  dirty: boolean;
  edit: (patch: Partial<T>) => void;
  /** Call after a successful save: the next stored value replaces the draft. */
  saved: () => void;
}

/**
 * The draft once the stored value moves from `previous` to `stored`. A draft
 * without unsaved edits follows it, one with edits keeps them, and a draft
 * that was just saved takes what the server kept.
 */
export function followStoredDraft<T>(
  current: T,
  previous: T | undefined,
  stored: T,
  justSaved: boolean,
  same: (a: T, b: T) => boolean,
): T {
  return justSaved || previous === undefined || same(current, previous) ? stored : current;
}

/**
 * A settings form that saves explicitly. `stored` must keep its identity
 * until the stored value really changes (memoize it), and `same` compares
 * the way the server normalizes, e.g. ignoring surrounding whitespace.
 */
export function useSettingsDraft<T>(
  stored: T | undefined,
  initial: T,
  same: (a: T, b: T) => boolean,
): SettingsDraft<T> {
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState<T | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  // Adjusted while rendering, so the form never paints a stale comparison.
  if (stored !== undefined && stored !== baseline) {
    setBaseline(stored);
    setJustSaved(false);
    setDraft(followStoredDraft(draft, baseline, stored, justSaved, same));
  }
  return {
    draft,
    dirty: baseline !== undefined && !same(draft, baseline),
    edit: (patch) => setDraft((current) => ({ ...current, ...patch })),
    saved: () => setJustSaved(true),
  };
}
