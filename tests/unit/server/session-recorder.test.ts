import { afterEach, describe, expect, it, vi } from 'vitest';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import {
  SessionRecorder,
  TerminalTextNormalizer,
  sessionProfileIdentity,
} from '../../../server/src/session-logging/session-recorder.js';
import { SessionHistoryStore } from '../../../server/src/session-logging/history-store.js';

let database: MuxusDatabase | undefined;
let history: SessionHistoryStore | undefined;

afterEach(async () => {
  await history?.close();
  history = undefined;
  database?.close();
  database = undefined;
});

describe('SessionRecorder', () => {
  it('persists line times through delayed snapshots and coalesced batches', async () => {
    database = new MuxusDatabase(':memory:');
    history = await openHistory(database);
    const recorder = SessionRecorder.start(database, history, { warn: vi.fn() } as never, { kind: 'local' });
    recorder.setState({ enabled: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
      recorder.output('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
      vi.setSystemTime(new Date('2026-09-24T10:00:05.000Z'));
      recorder.output('six\r\n');
      vi.setSystemTime(new Date('2026-09-24T11:00:00.000Z'));
      recorder.end('completed');
    } finally {
      vi.useRealTimers();
    }
    const detail = (await history.sessionLog(recorder.state.sessionId!))!;
    const output = detail.events.filter((event) => event.direction === 'output');
    expect(output.map((event) => event.text).join('')).toBe('one\ntwo\nthree\nfour\nfive\nsix\n');
    expect(output.flatMap((event) => event.lineTimestamps!.map((stamp) => stamp.recordedAt)))
      .toEqual([...Array(5).fill('2026-09-24T10:00:00.000Z'), '2026-09-24T10:00:05.000Z']);
    expect(output[0]!.lineTimestamps?.map((stamp) => stamp.offset)).toEqual([0, 4]);
  });

  it('keeps receive times across redraws, split UTF-8 and delayed drains', () => {
    const normalizer = new TerminalTextNormalizer();
    normalizer.write(Buffer.from('prompt> '), '2026-09-24T10:00:00.000Z');
    normalizer.write(Buffer.from('status\r\nloading 1%'), '2026-09-24T10:00:02.000Z');
    normalizer.write(Buffer.from('\r\x1b[2Kready\r\n'), '2026-09-24T10:00:03.000Z');
    const unicode = Buffer.from('✓');
    normalizer.write(unicode.subarray(0, 1), '2026-09-24T10:00:04.000Z');
    normalizer.write(unicode.subarray(1), '2026-09-24T10:00:05.000Z');
    expect(normalizer.finish()).toBe('prompt> status\nready\n✓');
    expect(normalizer.takeLineTimestamps()).toEqual([
      { offset: 0, recordedAt: '2026-09-24T10:00:02.000Z' },
      { offset: 15, recordedAt: '2026-09-24T10:00:03.000Z' },
      { offset: 21, recordedAt: '2026-09-24T10:00:05.000Z' },
    ]);
  });

  it('does not create a session log until logging is explicitly enabled', async () => {
    database = new MuxusDatabase(':memory:');
    history = await openHistory(database);
    const recorder = SessionRecorder.start(
      database,
      history,
      { warn: vi.fn() } as never,
      { kind: 'ssh', target: 'production' },
      'Production',
    );

    recorder.output(Buffer.from('must not be retained\r\n'));
    recorder.end('completed');

    expect(recorder.state).toMatchObject({
      enabled: false,
      paused: false,
      captureInput: false,
    });
    expect(recorder.state.sessionId).toBeUndefined();
    expect((await history.sessionHistory({ query: '', limit: 20 })).sessions).toEqual([]);
  });

  it('starts and stops distinct history sessions without interrupting the terminal', async () => {
    database = new MuxusDatabase(':memory:');
    history = await openHistory(database);
    const recorder = SessionRecorder.start(
      database,
      history,
      { warn: vi.fn() } as never,
      { kind: 'ssh', target: 'production' },
      'Production',
    );

    recorder.output(Buffer.from('before logging\r\n'));
    recorder.setState({ enabled: true });
    const firstSessionId = recorder.state.sessionId!;
    recorder.output(Buffer.from('first recording\r\n'));
    recorder.setState({ enabled: false });
    recorder.output(Buffer.from('between recordings\r\n'));
    recorder.setState({ enabled: true });
    const secondSessionId = recorder.state.sessionId!;
    recorder.output(Buffer.from('second recording\r\n'));
    recorder.end('completed');

    expect(firstSessionId).not.toBe(secondSessionId);
    const firstTranscript = (await history.sessionLog(firstSessionId))!.events
      .map((event) => event.text)
      .join('');
    const secondTranscript = (await history.sessionLog(secondSessionId))!.events
      .map((event) => event.text)
      .join('');
    expect(firstTranscript).toContain('first recording\n');
    expect(firstTranscript).toContain('Session logging stopped.');
    expect(firstTranscript).not.toContain('before logging');
    expect(firstTranscript).not.toContain('between recordings');
    expect(secondTranscript).toContain('second recording\n');
    expect(secondTranscript).not.toContain('between recordings');
  });

  it('suppresses input by default and honors pause/resume at runtime', async () => {
    database = new MuxusDatabase(':memory:');
    history = await openHistory(database);
    database.saveSessionLoggingPolicy('ssh:production', {
      enabled: true,
      captureInput: false,
      maxPartBytes: 5 * 1024 * 1024,
      maxParts: 10,
    });
    const recorder = SessionRecorder.start(
      database,
      history,
      { warn: vi.fn() } as never,
      { kind: 'ssh', target: 'production' },
      'Production',
    );

    recorder.input(Buffer.from('secret-token'));
    recorder.output(Buffer.from('\x1b[31mvisible error\x1b[0m\r\n'));
    recorder.setState({ paused: true });
    recorder.output(Buffer.from('not retained'));
    recorder.setState({ paused: false, captureInput: true });
    recorder.input(Buffer.from('safe-command\n'));
    recorder.end('completed');

    const detail = (await history.sessionLog(recorder.state.sessionId!))!;
    const transcript = detail.events.map((event) => event.text).join('');
    expect(transcript).toContain('visible error\n');
    expect(transcript).toContain('Session logging paused.');
    expect(transcript).toContain('Session logging resumed.');
    expect(transcript).toContain('safe-command\n');
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('not retained');
    expect(detail.status).toBe('completed');
    expect(detail.captureInput).toBe(true);
  });

  it('assigns stable policy keys to saved and ad-hoc hosts', () => {
    expect(sessionProfileIdentity({ kind: 'ssh', target: 'edge' }).profileKey)
      .toBe('ssh:edge');
    expect(sessionProfileIdentity({
      kind: 'ssh',
      profileId: 'saved-ssh-1',
      target: 'edge.example.test',
      useConfig: false,
    }).profileKey).toBe('profile:saved-ssh-1');
    expect(sessionProfileIdentity({
      kind: 'telnet',
      profileId: 'saved-1',
      host: 'router',
      port: 23,
    }).profileKey).toBe('profile:saved-1');
    expect(sessionProfileIdentity({
      kind: 'serial',
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    }).profileKey).toBe('serial:/dev/ttyUSB0');
    expect(sessionProfileIdentity({ kind: 'local' }).profileKey).toBe('local');
  });
});

function openHistory(database: MuxusDatabase): Promise<SessionHistoryStore> {
  return SessionHistoryStore.open({
    settings: database.sessionHistorySettings(),
  });
}

describe('TerminalTextNormalizer', () => {
  it('strips split ANSI/OSC payloads while preserving readable line breaks', () => {
    const normalizer = new TerminalTextNormalizer();
    const chunks = [
      normalizer.write(Buffer.from('one\r\n\x1b[31')),
      normalizer.write(Buffer.from('mred\x1b[0m \x1b]0;sec')),
      normalizer.write(Buffer.from('ret title\x07two\r\nthree')),
      normalizer.finish(),
    ];
    expect(chunks.join('')).toBe('one\nred two\nthree');
  });

  it('keeps only the visible zsh command when prompts and partial-line markers redraw', () => {
    const normalizer = new TerminalTextNormalizer();
    const chunks = [
      normalizer.write(Buffer.from('~          14:10:57\r\n❯ lll')),
      normalizer.write(Buffer.from('\r\x1b[K❯ ll\r\ntotal 271M\r\n')),
      normalizer.write(Buffer.from('%                 \r')),
      normalizer.write(Buffer.from('~          14:10:59\r\n❯ ppwd')),
      normalizer.write(Buffer.from('\r\x1b[K❯ pwd\r\n/home/flschwar\r\n')),
      normalizer.finish(),
    ];
    const transcript = chunks.join('');

    expect(transcript).toBe(
      '~          14:10:57\n' +
      '❯ ll\n' +
      'total 271M\n' +
      '~          14:10:59\n' +
      '❯ pwd\n' +
      '/home/flschwar\n',
    );
    expect(transcript).not.toContain('lll');
    expect(transcript).not.toContain('ppwd');
    expect(transcript).not.toContain('%');
  });

  it('reconciles carriage-return progress updates instead of duplicating them', () => {
    const normalizer = new TerminalTextNormalizer();
    normalizer.write(Buffer.from('Downloading 10%\rDownloading 100%\r\n'));

    expect(normalizer.finish()).toBe('Downloading 100%\n');
  });
});
