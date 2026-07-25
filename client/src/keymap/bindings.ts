import { chordSignature, eventSignature, parseChord, type ChordEvent } from './chords.js';
import { KEY_COMMANDS, keyCommand, type KeyCommand } from './commands.js';

/** Command id → chords, replacing that command's defaults. */
export type KeybindingOverrides = Record<string, string[]>;

export const NO_OVERRIDES: KeybindingOverrides = {};

/** The chords a command answers to, honoring the user's overrides. */
export function commandChords(
  command: KeyCommand,
  overrides: KeybindingOverrides = NO_OVERRIDES,
): string[] {
  return overrides[command.id] ?? command.defaultChords;
}

export function isCommandCustomized(
  command: KeyCommand,
  overrides: KeybindingOverrides = NO_OVERRIDES,
): boolean {
  const chords = overrides[command.id];
  return chords !== undefined && !chordsAreDefault(command, chords);
}

/** Whether a chord list is exactly what the command ships with. */
export function chordsAreDefault(command: KeyCommand, chords: readonly string[]): boolean {
  return (
    chords.length === command.defaultChords.length &&
    chords.every((chord, index) => sameChord(chord, command.defaultChords[index]))
  );
}

function sameChord(left: string, right: string | undefined): boolean {
  if (right === undefined) return false;
  const parsedLeft = parseChord(left);
  const parsedRight = parseChord(right);
  if (!parsedLeft || !parsedRight) return left === right;
  return chordSignature(parsedLeft) === chordSignature(parsedRight);
}

/**
 * Signature → commands, in catalog order. Several commands can share a
 * signature after rebinding; the dispatcher tries each until one applies and
 * the shortcut settings surface them as a conflict.
 */
export function buildBindingIndex(
  overrides: KeybindingOverrides = NO_OVERRIDES,
): Map<string, KeyCommand[]> {
  const index = new Map<string, KeyCommand[]>();
  for (const command of KEY_COMMANDS) {
    for (const text of commandChords(command, overrides)) {
      const chord = parseChord(text);
      if (!chord) continue;
      const signature = chordSignature(chord);
      const existing = index.get(signature);
      if (existing) existing.push(command);
      else index.set(signature, [command]);
    }
  }
  return index;
}

/** Commands that a chord would trigger, most relevant first. */
export function commandsForChord(
  text: string,
  overrides: KeybindingOverrides = NO_OVERRIDES,
): KeyCommand[] {
  const chord = parseChord(text);
  if (!chord) return [];
  return buildBindingIndex(overrides).get(chordSignature(chord)) ?? [];
}

/** Command ids that share at least one chord with another command. */
export function conflictingCommandIds(
  overrides: KeybindingOverrides = NO_OVERRIDES,
): Set<string> {
  const conflicts = new Set<string>();
  for (const commands of buildBindingIndex(overrides).values()) {
    if (commands.length < 2) continue;
    for (const command of commands) conflicts.add(command.id);
  }
  return conflicts;
}

let cachedOverrides: KeybindingOverrides | undefined;
let cachedIndex: Map<string, KeyCommand[]> = new Map();

/** Cached lookup for the hot keydown path; rebuilt when preferences change. */
export function commandsForEvent(
  event: ChordEvent,
  overrides: KeybindingOverrides,
): KeyCommand[] {
  if (cachedOverrides !== overrides) {
    cachedOverrides = overrides;
    cachedIndex = buildBindingIndex(overrides);
  }
  return cachedIndex.get(eventSignature(event)) ?? [];
}

export { keyCommand };
