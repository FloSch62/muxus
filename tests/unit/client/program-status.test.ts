import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROGRAM_STATUS_RECORDS,
  PROGRAM_STATUS_QUERY_REPLY,
  applyProgramStatus,
  attachProgramStatus,
  dropTransientProgramStatus,
  parseProgramStatus,
  programStatusLabel,
  summarizeProgramStatus,
  type ProgramStatusChange,
  type ProgramStatusRecord,
  type ProgramStatusReport,
} from '../../../client/src/terminal/program-status.js';
import { useProgramStatusStore } from '../../../client/src/state/program-status.js';
import { useTabsStore } from '../../../client/src/state/tabs.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

function report(data: string): Extract<ProgramStatusReport, { type: 'report' }>['record'] {
  const parsed = parseProgramStatus(data);
  if (parsed?.type !== 'report') throw new Error(`not a report: ${data}`);
  return parsed.record;
}

function records(...lines: string[]): ProgramStatusRecord[] {
  let result: ProgramStatusRecord[] = [];
  lines.forEach((line, index) => {
    const parsed = parseProgramStatus(line);
    if (!parsed || parsed.type === 'query') throw new Error(`bad line: ${line}`);
    result = applyProgramStatus(result, parsed, index + 1);
  });
  return result;
}

describe('parsing OSC 7501 reports', () => {
  it('reads a full report with base64 text', () => {
    expect(
      report(`state=working:app=make:progress=40:title=${b64('Build')}:msg=${b64('Linking ✓')}`),
    ).toEqual({ id: '', state: 'working', app: 'make', progress: 40, title: 'Build', msg: 'Linking ✓' });
  });

  it('recognises the support query', () => {
    expect(parseProgramStatus('?')).toEqual({ type: 'query' });
  });

  it('requires a known state', () => {
    expect(parseProgramStatus('app=make')).toBeUndefined();
    expect(parseProgramStatus('state=sleeping')).toBeUndefined();
  });

  it('addresses clears by id', () => {
    expect(parseProgramStatus('state=clear:id=build/test')).toEqual({ type: 'clear', id: 'build/test' });
    expect(parseProgramStatus('state=clear')).toEqual({ type: 'clear', id: '' });
  });

  it('skips malformed pairs, ignores unknown keys and keeps the last repeat', () => {
    expect(report('state=idle:noise:future=1:app=a:app=b:state=done:app=bad app')).toEqual({
      id: '',
      state: 'done',
      app: 'b',
    });
  });

  it('keeps kind only for blocked and progress only while working or blocked', () => {
    expect(report('state=blocked:kind=permission:progress=10')).toMatchObject({
      kind: 'permission',
      progress: 10,
    });
    expect(report('state=blocked:kind=coffee')).not.toHaveProperty('kind');
    expect(report('state=done:kind=question:progress=50')).toEqual({ id: '', state: 'done' });
    expect(report('state=working:progress=101')).not.toHaveProperty('progress');
  });

  it('discards a report whose text is invalid or carries control characters', () => {
    expect(parseProgramStatus('state=done:msg=abcde')).toBeUndefined();
    expect(parseProgramStatus('state=done:msg=@@@')).toEqual({ type: 'report', record: { id: '', state: 'done' } });
    expect(parseProgramStatus(`state=done:msg=${b64('a\x1b[31mred')}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:title=${b64('a\u0085b')}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`)).toBeUndefined();
  });

  it('strips bidi overrides and invisible characters from text', () => {
    expect(report(`state=done:msg=${b64('safe‮txt.exe​')}`).msg).toBe('safetxt.exe');
  });

  it('enforces the size limits', () => {
    expect(parseProgramStatus(`state=done:msg=${b64('x'.repeat(2049))}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:title=${b64('x'.repeat(193))}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:id=${Array(9).fill('a').join('/')}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:id=${'a'.repeat(33)}`)).toBeUndefined();
    expect(parseProgramStatus(`state=done:app=x:${'z'.repeat(4096)}`)).toBeUndefined();
  });
});

describe('program status records', () => {
  it('replaces a record completely on each report', () => {
    const result = records('state=working:app=make:msg=' + b64('one'), 'state=done');
    expect(result).toEqual([{ id: '', state: 'done', seq: 2 }]);
  });

  it('clears a record together with its children', () => {
    const result = records(
      'state=working:id=build',
      'state=working:id=build/test',
      'state=working:id=builder',
      'state=clear:id=build',
    );
    expect(result.map((record) => record.id)).toEqual(['builder']);
    expect(applyProgramStatus(result, { type: 'clear', id: '' }, 9)).toEqual([]);
  });

  it('evicts the least recently updated record when full', () => {
    let result: ProgramStatusRecord[] = [];
    for (let index = 0; index <= MAX_PROGRAM_STATUS_RECORDS; index++) {
      result = applyProgramStatus(
        result,
        { type: 'report', record: { id: `r${index}`, state: 'idle' } },
        index + 1,
      );
    }
    expect(result).toHaveLength(MAX_PROGRAM_STATUS_RECORDS);
    expect(result.some((record) => record.id === 'r0')).toBe(false);
  });

  it('drops working and blocked but keeps finished results', () => {
    const result = records('state=working:id=a', 'state=blocked:id=b', 'state=done:id=c', 'state=idle:id=d');
    expect(dropTransientProgramStatus(result).map((record) => record.id)).toEqual(['c', 'd']);
    const settled = records('state=done');
    expect(dropTransientProgramStatus(settled)).toBe(settled);
  });
});

describe('summarizing a tab', () => {
  it('shows the most urgent state', () => {
    const result = records('state=working:id=a', 'state=blocked:id=b:kind=question', 'state=error:id=c');
    expect(summarizeProgramStatus(result, true)?.id).toBe('b');
  });

  it('shows finished results only while unseen', () => {
    const result = records('state=done:id=a', 'state=working:id=b', 'state=error:id=c');
    expect(summarizeProgramStatus(result, true)?.id).toBe('c');
    expect(summarizeProgramStatus(result, false)?.id).toBe('b');
    expect(summarizeProgramStatus(records('state=done'), false)).toBeUndefined();
  });

  it('shows nothing for idle programs', () => {
    expect(summarizeProgramStatus(records('state=idle'), true)).toBeUndefined();
  });

  it('prefers the latest of equally urgent records', () => {
    expect(summarizeProgramStatus(records('state=working:id=a', 'state=working:id=b'), true)?.id).toBe('b');
  });

  it('inherits the app name from an ancestor', () => {
    const result = records('state=idle:app=agent', 'state=working:id=helper/one');
    expect(summarizeProgramStatus(result, true)).toMatchObject({ id: 'helper/one', app: 'agent' });
  });

  it('labels each state', () => {
    expect(programStatusLabel({ state: 'working' })).toBe('Working');
    expect(programStatusLabel({ state: 'working', progress: 30 })).toBe('Working, 30%');
    expect(programStatusLabel({ state: 'blocked', kind: 'auth' })).toBe('Waiting for you to sign in');
    expect(programStatusLabel({ state: 'blocked' })).toBe('Waiting for you');
    expect(programStatusLabel({ state: 'error' })).toBe('Failed');
  });
});

type OscHandler = (data: string) => boolean;

class StubParser {
  osc = new Map<number, OscHandler[]>();
  esc: Array<() => boolean> = [];
  registerOscHandler(ident: number, handler: OscHandler) {
    const list = this.osc.get(ident) ?? [];
    list.push(handler);
    this.osc.set(ident, list);
    return { dispose: () => list.splice(list.indexOf(handler), 1) };
  }
  registerEscHandler(_id: { final: string }, handler: () => boolean) {
    this.esc.push(handler);
    return { dispose: () => this.esc.splice(this.esc.indexOf(handler), 1) };
  }
  /** Run handlers newest first, as xterm does, until one consumes it. */
  oscIn(ident: number, data: string): boolean {
    const list = [...(this.osc.get(ident) ?? [])].reverse();
    return list.some((handler) => handler(data));
  }
}

function attached(enabled = true) {
  const parser = new StubParser();
  let state: readonly ProgramStatusRecord[] = [];
  const replies: string[] = [];
  const handle = attachProgramStatus({ parser } as unknown as Parameters<typeof attachProgramStatus>[0], {
    enabled: () => enabled,
    reply: (data) => replies.push(data),
    update: (change: ProgramStatusChange) => {
      state = change(state);
    },
  });
  return { parser, replies, handle, records: () => state };
}

describe('terminal wiring', () => {
  it('records reports and answers the support query on the session only', () => {
    const { parser, replies, records: current } = attached();
    expect(parser.oscIn(7501, 'state=working:app=make')).toBe(true);
    expect(current()).toMatchObject([{ state: 'working', app: 'make' }]);
    parser.oscIn(7501, '?');
    expect(replies).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe(
      '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\',
    );
  });

  it('ignores reports and stays silent when turned off', () => {
    const { parser, replies, records: current } = attached(false);
    expect(parser.oscIn(7501, '?')).toBe(false);
    parser.oscIn(7501, 'state=working');
    expect(replies).toEqual([]);
    expect(current()).toEqual([]);
  });

  it('drops work in progress at the next prompt without hiding it from shell integration', () => {
    const { parser, records: current } = attached();
    const shellIntegration = vi.fn(() => true);
    parser.osc.get(133)!.unshift(shellIntegration);
    parser.oscIn(7501, 'state=working:id=a');
    parser.oscIn(7501, 'state=done:id=b');
    parser.oscIn(133, 'C');
    expect(current()).toHaveLength(2);
    parser.oscIn(133, 'A');
    expect(current().map((record) => record.id)).toEqual(['b']);
    expect(shellIntegration).toHaveBeenCalledTimes(2);
  });

  it('clears everything on a terminal reset or a new session', () => {
    const { parser, handle, records: current } = attached();
    parser.oscIn(7501, 'state=done');
    expect(parser.esc[0]!()).toBe(false);
    expect(current()).toEqual([]);
    parser.oscIn(7501, 'state=done');
    handle.reset();
    expect(current()).toEqual([]);
  });

  it('keeps finished results when the session ends', () => {
    const { parser, handle, records: current } = attached();
    parser.oscIn(7501, 'state=working:id=a');
    parser.oscIn(7501, 'state=error:id=b');
    handle.sessionEnded();
    expect(current().map((record) => record.id)).toEqual(['b']);
  });
});

describe('program status store', () => {
  beforeEach(() => {
    useProgramStatusStore.setState({ byTab: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const apply = (tabId: string, line: string, seq: number) => {
    const parsed = parseProgramStatus(line);
    if (!parsed || parsed.type === 'query') throw new Error(line);
    useProgramStatusStore.getState().update(tabId, (current) => applyProgramStatus(current, parsed, seq));
  };

  it('keeps a finished result unseen until the tab is looked at', () => {
    apply('tab-1', 'state=working', 1);
    expect(useProgramStatusStore.getState().byTab['tab-1']?.unseen).toBe(false);
    apply('tab-1', 'state=done', 2);
    expect(useProgramStatusStore.getState().byTab['tab-1']?.unseen).toBe(true);
    useProgramStatusStore.getState().markSeen('tab-1');
    expect(useProgramStatusStore.getState().byTab['tab-1']?.unseen).toBe(false);
  });

  it('counts a result as seen when it finishes in the tab being watched', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    useTabsStore.setState({ activeId: 'tab-2' });
    apply('tab-2', 'state=done', 1);
    expect(useProgramStatusStore.getState().byTab['tab-2']?.unseen).toBe(false);
  });

  it('marks the result seen when its tab is activated', () => {
    apply('tab-3', 'state=done', 1);
    vi.stubGlobal('document', { hasFocus: () => true });
    useTabsStore.setState({ activeId: 'tab-3' });
    expect(useProgramStatusStore.getState().byTab['tab-3']?.unseen).toBe(false);
  });

  it('forgets a tab once its records are empty or the tab closes', () => {
    apply('tab-4', 'state=working', 1);
    apply('tab-4', 'state=clear', 2);
    expect(useProgramStatusStore.getState().byTab).not.toHaveProperty('tab-4');

    apply('tab-5', 'state=done', 3);
    const { tabs } = useTabsStore.getState();
    useTabsStore.setState({ tabs: [...tabs] });
    expect(useProgramStatusStore.getState().byTab).not.toHaveProperty('tab-5');
  });
});
