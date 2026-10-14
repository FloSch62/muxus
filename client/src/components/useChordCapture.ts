import { useEffect, useRef } from 'react';
import { chordFromEvent, isBindableChord, isModifierCode, type Chord } from '../keymap/chords.js';
import { setChordCaptureActive, swallowKeyUp } from '../shortcuts.js';

export interface ChordCaptureHandlers {
  /** A bindable chord was pressed. */
  onChord: (chord: Chord) => void;
  /** Esc was pressed. */
  onCancel: () => void;
  /** A chord was refused; recording goes on. */
  onRefused: (message: string) => void;
}

/**
 * Record the chords pressed until the returned function stops it. The
 * dispatcher stands down meanwhile, so the chord being captured cannot fire
 * the command it is about to replace.
 */
export function captureChords(handlers: () => ChordCaptureHandlers): () => void {
  setChordCaptureActive(true);
  const onKeyDown = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isModifierCode(event.code)) return;
    if (!event.repeat) swallowKeyUp(event.code);
    if (event.code === 'Escape') {
      handlers().onCancel();
      return;
    }
    const chord = chordFromEvent(event);
    if (!isBindableChord(chord)) {
      handlers().onRefused('Add Ctrl, Alt, or Cmd — Shift alone would swallow ordinary typing.');
      return;
    }
    handlers().onChord(chord);
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    setChordCaptureActive(false);
  };
}

/** Record the chords pressed while `active`, with `captureChords`. */
export function useChordCapture(active: boolean, handlers: ChordCaptureHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => (active ? captureChords(() => latest.current) : undefined), [active]);
}
