import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * OSC 7501, the Program Status Protocol: a program in the terminal reports
 * what it is doing (working, blocked on the user, done, failed) so the
 * terminal can show it without reading the screen.
 *
 *   ESC ] 7501 ; state=working:app=make:msg=<base64> ST
 *
 * Every report replaces one record, addressed by an optional `/`-separated
 * id. Everything in a report is untrusted program output.
 */
export const PROGRAM_STATUS_OSC = 7501;

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type ProgramBlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusRecord {
  /** Empty for the root record. */
  id: string;
  state: ProgramState;
  kind?: ProgramBlockedKind;
  /** 0–100 while working or blocked; absent means indeterminate. */
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
  /** Monotonic update order, for eviction and tie-breaking. */
  seq: number;
}

export type ProgramStatusReport =
  | { type: 'query' }
  | { type: 'clear'; id: string }
  | { type: 'report'; record: Omit<ProgramStatusRecord, 'seq'> };

/** The reply to `OSC 7501 ; ?`: the states and blocked kinds this terminal shows. */
export const PROGRAM_STATUS_QUERY_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

export const MAX_PROGRAM_STATUS_RECORDS = 256;
const MAX_SEQUENCE_BYTES = 4096;
const MAX_MSG_BYTES = 2048;
const MAX_TITLE_BYTES = 192;
const MAX_ID_LENGTH = 128;
const MAX_ID_DEPTH = 8;

const STATES: ReadonlySet<string> = new Set(['idle', 'working', 'blocked', 'done', 'error']);
const KINDS: ReadonlySet<string> = new Set(['permission', 'question', 'auth']);
const VALUE_PATTERN = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
// C0, DEL and C1 controls: never allowed in decoded text.
// oxlint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
// Bidi overrides and invisible characters that could disguise the text.
const INVISIBLE_PATTERN = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

function validId(id: string): boolean {
  if (id.length > MAX_ID_LENGTH) return false;
  const segments = id.split('/');
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT_PATTERN.test(segment));
}

/** Decode a base64 text value, or undefined when the whole report must be dropped. */
function decodeText(value: string, maxBytes: number): string | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
  if (bytes.length > maxBytes) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  if (CONTROL_PATTERN.test(text)) return undefined;
  return text.replace(INVISIBLE_PATTERN, '');
}

/** Parse one OSC 7501 payload (the part after `7501;`). */
export function parseProgramStatus(data: string): ProgramStatusReport | undefined {
  if (textEncoder.encode(data).length > MAX_SEQUENCE_BYTES) return undefined;
  if (data === '?' || data.startsWith('?:')) return { type: 'query' };

  const pairs = new Map<string, string>();
  for (const pair of data.split(':')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const value = pair.slice(separator + 1);
    // Malformed pairs are skipped; a repeated key keeps its last value.
    if (!VALUE_PATTERN.test(value)) continue;
    pairs.set(pair.slice(0, separator), value);
  }

  const state = pairs.get('state');
  if (state === undefined) return undefined;
  const id = pairs.get('id') ?? '';
  if (id && !validId(id)) return undefined;
  if (state === 'clear') return { type: 'clear', id };
  if (!STATES.has(state)) return undefined;

  const record: Omit<ProgramStatusRecord, 'seq'> = { id, state: state as ProgramState };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && KINDS.has(kind)) {
    record.kind = kind as ProgramBlockedKind;
  }
  const progress = pairs.get('progress');
  if ((state === 'working' || state === 'blocked') && progress !== undefined && /^\d{1,3}$/.test(progress)) {
    const value = Number.parseInt(progress, 10);
    if (value <= 100) record.progress = value;
  }
  const app = pairs.get('app');
  if (app !== undefined && APP_PATTERN.test(app)) record.app = app;
  for (const [key, maxBytes] of [['title', MAX_TITLE_BYTES], ['msg', MAX_MSG_BYTES]] as const) {
    const value = pairs.get(key);
    if (value === undefined) continue;
    const text = decodeText(value, maxBytes);
    if (text === undefined) return undefined;
    if (text) record[key] = text;
  }
  return { type: 'report', record };
}

function isWithin(id: string, ancestor: string): boolean {
  return ancestor === '' || id === ancestor || id.startsWith(`${ancestor}/`);
}

/** Apply a report to one terminal's records, returning a new list. */
export function applyProgramStatus(
  records: readonly ProgramStatusRecord[],
  report: Exclude<ProgramStatusReport, { type: 'query' }>,
  seq: number,
): ProgramStatusRecord[] {
  if (report.type === 'clear') return records.filter((record) => !isWithin(record.id, report.id));
  const next = records.filter((record) => record.id !== report.record.id);
  next.push({ ...report.record, seq });
  if (next.length > MAX_PROGRAM_STATUS_RECORDS) {
    // Evict the least recently updated record.
    let oldest = 0;
    for (let index = 1; index < next.length; index++) {
      if (next[index]!.seq < next[oldest]!.seq) oldest = index;
    }
    next.splice(oldest, 1);
  }
  return next;
}

/**
 * Working and blocked last only as long as the program: a new shell prompt or
 * the end of the session drops them. Done and error stay until replaced.
 */
export function dropTransientProgramStatus(
  records: readonly ProgramStatusRecord[],
): readonly ProgramStatusRecord[] {
  const next = records.filter((record) => record.state !== 'working' && record.state !== 'blocked');
  return next.length === records.length ? records : next;
}

export function isFinishedProgramState(state: ProgramState): boolean {
  return state === 'done' || state === 'error';
}

const STATE_PRIORITY: Record<ProgramState, number> = {
  blocked: 4,
  error: 3,
  working: 2,
  done: 1,
  idle: 0,
};

/**
 * The one record a tab shows: the most urgent state, the latest report among
 * equals. Done and error count only while they are unseen. Idle shows nothing.
 * The app name is inherited from the nearest ancestor that set one.
 */
export function summarizeProgramStatus(
  records: readonly ProgramStatusRecord[],
  includeFinished: boolean,
): ProgramStatusRecord | undefined {
  let best: ProgramStatusRecord | undefined;
  for (const record of records) {
    if (record.state === 'idle') continue;
    if (!includeFinished && isFinishedProgramState(record.state)) continue;
    if (
      !best ||
      STATE_PRIORITY[record.state] > STATE_PRIORITY[best.state] ||
      (STATE_PRIORITY[record.state] === STATE_PRIORITY[best.state] && record.seq > best.seq)
    ) {
      best = record;
    }
  }
  if (!best || best.app) return best;
  const byId = new Map(records.map((record) => [record.id, record]));
  let id = best.id;
  while (id) {
    const separator = id.lastIndexOf('/');
    id = separator === -1 ? '' : id.slice(0, separator);
    const app = byId.get(id)?.app;
    if (app) return { ...best, app };
  }
  return best;
}

export type ProgramStatusChange = (
  records: readonly ProgramStatusRecord[],
) => readonly ProgramStatusRecord[];

export interface ProgramStatusHandle extends IDisposable {
  /** A new session started in the terminal: nothing from the old one applies. */
  reset(): void;
  /** The session ended: the programs reporting work in it are gone. */
  sessionEnded(): void;
}

let nextSeq = 1;

/**
 * Listen for OSC 7501 reports and answer support queries. Replies go straight
 * to this terminal's session, never through onData, so mirrored input does
 * not carry them to other terminals. Records live outside the terminal so a
 * remounted view keeps them.
 */
export function attachProgramStatus(
  term: Terminal,
  options: {
    enabled: () => boolean;
    reply: (data: string) => void;
    update: (change: ProgramStatusChange) => void;
  },
): ProgramStatusHandle {
  const reset = () => options.update((records) => (records.length ? [] : records));
  const dropTransient = () => options.update(dropTransientProgramStatus);

  const osc = term.parser.registerOscHandler(PROGRAM_STATUS_OSC, (data) => {
    if (!options.enabled()) return false;
    const report = parseProgramStatus(data);
    if (!report) return true;
    if (report.type === 'query') {
      options.reply(PROGRAM_STATUS_QUERY_REPLY);
      return true;
    }
    const seq = nextSeq++;
    options.update((records) => applyProgramStatus(records, report, seq));
    return true;
  });
  // A new prompt means the foreground program ended. Return false so the
  // shell-integration handlers see the same sequence.
  const onPrompt = (data: string) => {
    if (data === 'A' || data.startsWith('A;')) dropTransient();
    return false;
  };
  const osc133 = term.parser.registerOscHandler(133, onPrompt);
  const osc633 = term.parser.registerOscHandler(633, onPrompt);
  // RIS (ESC c), a full terminal reset, clears every record.
  const ris = term.parser.registerEscHandler({ final: 'c' }, () => {
    reset();
    return false;
  });

  return {
    reset,
    sessionEnded: dropTransient,
    dispose: () => {
      osc.dispose();
      osc133.dispose();
      osc633.dispose();
      ris.dispose();
    },
  };
}

const BLOCKED_LABELS: Record<ProgramBlockedKind, string> = {
  permission: 'Waiting for your permission',
  question: 'Waiting for your answer',
  auth: 'Waiting for you to sign in',
};

/** The headline a tab's status reads as. */
export function programStatusLabel(record: Pick<ProgramStatusRecord, 'state' | 'kind' | 'progress'>): string {
  switch (record.state) {
    case 'working':
      return record.progress === undefined ? 'Working' : `Working, ${record.progress}%`;
    case 'blocked':
      return record.kind ? BLOCKED_LABELS[record.kind] : 'Waiting for you';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
    default:
      return 'Idle';
  }
}
