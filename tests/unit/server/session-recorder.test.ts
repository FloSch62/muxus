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
