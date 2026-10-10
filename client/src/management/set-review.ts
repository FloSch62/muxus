import { stripModulePrefix } from '@muxus/shared';
import { guessListKeys } from './data-tree.js';
import type { GnmiDraft, GnmiSetItem } from './requests.js';

/**
 * What a gNMI Set will leave behind, per change, so it can be shown as a
 * diff before it is sent: replace puts the value in place, update merges it
 * (list entries by their key), delete removes the path.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same leaf or container, whether or not the JSON qualified it with its module. */
function sameName(a: string, b: string): boolean {
  return a === b || stripModulePrefix(a) === stripModulePrefix(b);
}

function mergeLists(current: unknown[], update: unknown[]): unknown[] {
  if (!current.every(isPlainObject) || !update.every(isPlainObject)) return update;
  const keys = guessListKeys([...(current as Record<string, unknown>[]), ...(update as Record<string, unknown>[])]);
  if (keys.length === 0) return update;
  const identity = (entry: Record<string, unknown>) =>
    keys.map((key) => {
      const field = Object.keys(entry).find((name) => sameName(name, key));
      return field === undefined ? '' : JSON.stringify(entry[field]);
    }).join('\u0000');
  const merged = [...(current as Record<string, unknown>[])];
  for (const entry of update as Record<string, unknown>[]) {
    const index = merged.findIndex((candidate) => identity(candidate) === identity(entry));
    if (index >= 0) merged[index] = mergeValue(merged[index], entry) as Record<string, unknown>;
    else merged.push(entry);
  }
  return merged;
}

/** gNMI update semantics: objects merge, lists merge by key, scalars replace. */
export function mergeValue(current: unknown, update: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(update)) {
    const out: Record<string, unknown> = { ...current };
    for (const [name, value] of Object.entries(update)) {
      const existing = Object.keys(out).find((candidate) => sameName(candidate, name));
      if (existing !== undefined) {
        out[existing] = mergeValue(out[existing], value);
      } else {
        out[name] = value;
      }
    }
    return out;
  }
  if (Array.isArray(current) && Array.isArray(update)) return mergeLists(current, update);
  return update;
}

/** Stable key order, so a diff shows content changes and not ordering. */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (isPlainObject(input)) {
      return Object.fromEntries(
        Object.keys(input)
          .sort((a, b) => stripModulePrefix(a).localeCompare(stripModulePrefix(b)))
          .map((key) => [key, sort(input[key])]),
      );
    }
    return input;
  };
  return value === undefined ? '' : JSON.stringify(sort(value), null, 2);
}

export function proposedValue(item: GnmiSetItem, current: unknown): unknown {
  if (item.op === 'delete') return undefined;
  if (item.encoding === 'ascii') return item.value;
  const parsed = JSON.parse(item.value) as unknown;
  return item.op === 'replace' ? parsed : mergeValue(current, parsed);
}

export function setItems(draft: GnmiDraft): GnmiSetItem[] {
  return draft.set.filter((item) => item.path.trim());
}
