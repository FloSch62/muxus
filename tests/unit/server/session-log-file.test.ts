import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuxusDatabase } from '../../../server/src/persistence/database.js';
import { SessionHistoryStore } from '../../../server/src/session-logging/history-store.js';
import {
  SessionLogFile,
  unusedSessionLogFilePath,
} from '../../../server/src/session-logging/session-log-file.js';
import { SessionRecorder } from '../../../server/src/session-logging/session-recorder.js';

let directory: string;
let database: MuxusDatabase | undefined;
let history: SessionHistoryStore | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'muxus-log-files-'));
});

afterEach(async () => {
  await history?.close();
  history = undefined;
  database?.close();
  database = undefined;
  rmSync(directory, { recursive: true, force: true });
});

/** Writes are asynchronous; wait until the file holds everything expected. */
async function fileText(file: string, until: string): Promise<string> {
  let text = '';
  await vi.waitFor(() => {
    text = readFileSync(file, 'utf8');
    expect(text).toContain(until);
  });
  return text;
}

describe('SessionLogFile', () => {
  it('writes the normalized transcript and the rows still on screen at close', async () => {
    const file = path.join(directory, 'nested', 'router.log');
    const log = SessionLogFile.open(file, { append: false, timestamps: false });
    log.system('Logging to file started.');
    log.output(Buffer.from('\x1b[32mone\x1b[0m\r\ntwo\r\nloading 1%\r\x1b[2Kready\r\n$ '));
    log.close('Logging to file stopped.');

    expect(await fileText(file, 'stopped')).toBe(
      'Logging to file started.\none\ntwo\nready\n$\nLogging to file stopped.\n',
    );
  });

  it('prefixes lines with the time they last changed', async () => {
    const file = path.join(directory, 'timed.log');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      const log = SessionLogFile.open(file, { append: false, timestamps: true });
      log.output(Buffer.from('first\r\nsec'));
      vi.setSystemTime(new Date('2026-10-04T10:00:05.000Z'));
      log.output(Buffer.from('ond\r\n'));
      log.close('done');
    } finally {
      vi.useRealTimers();
    }
    expect(await fileText(file, 'done')).toBe(
      '[2026-10-04T10:00:00.000Z] first\n' +
        '[2026-10-04T10:00:05.000Z] second\n' +
        '[2026-10-04T10:00:05.000Z] done\n',
    );
  });

  it('appends to a chosen file and numbers generated names that exist', async () => {
    const chosen = path.join(directory, 'chosen.log');
    writeFileSync(chosen, 'earlier session');
    const appended = SessionLogFile.open(chosen, { append: true, timestamps: false });
    appended.close('later session');
    expect(await fileText(chosen, 'later')).toBe('earlier session\nlater session\n');

    expect(unusedSessionLogFilePath(chosen)).toBe(path.join(directory, 'chosen-1.log'));
    const generated = SessionLogFile.open(chosen, { append: false, timestamps: false });
    expect(generated.path).toBe(path.join(directory, 'chosen-1.log'));
    generated.close('new file');
    await fileText(generated.path, 'new file');
    expect(readFileSync(chosen, 'utf8')).toBe('earlier session\nlater session\n');
  });

  it('refuses relative paths', () => {
    expect(() =>
      SessionLogFile.open('relative.log', { append: true, timestamps: false }),
    ).toThrow(/absolute/);
  });
});

describe('SessionRecorder log files', () => {
  async function openRecorder(policy: { enabled?: boolean; logToFile?: boolean } = {}) {
    database = new MuxusDatabase(':memory:');
    history = await SessionHistoryStore.open({ settings: database.sessionHistorySettings() });
    database.saveSessionLogFileSettings({
      directory,
      filenamePattern: '{host}.log',
      timestamps: false,
    });
    database.saveSessionLoggingPolicy('*', {
      enabled: policy.enabled ?? false,
      captureInput: false,
      maxPartBytes: 1024 * 1024,
      maxParts: 2,
      logToFile: policy.logToFile ?? false,
    });
    return SessionRecorder.start(
      database,
      history,
      { warn: vi.fn() } as never,
      { kind: 'ssh', target: 'router1' },
      'Core router',
    );
  }

  it('starts a log file with the session when the policy asks for it', async () => {
    const recorder = await openRecorder({ logToFile: true });
    const file = path.join(directory, 'router1.log');
    expect(recorder.state).toMatchObject({ enabled: false, filePath: file });

    recorder.system('Connecting to router1 …');
    recorder.output('show version\r\nSR OS 25.7\r\n');
    recorder.end('disconnected');

    const text = await fileText(file, 'ended');
    expect(text).toMatch(/^Logging to file started: Core router \(router1\) at \S+\.\n/);
    expect(text).toContain('Connecting to router1 …\nshow version\nSR OS 25.7\n');
    expect(text).toMatch(/Logging to file ended \(disconnected\) at \S+\.\n$/);
    expect(recorder.state.filePath).toBeUndefined();
  });

  it('pauses and records input in the log file without session history', async () => {
    const recorder = await openRecorder();
    const file = path.join(directory, 'manual.log');
    expect(recorder.setState({ logToFile: true, logFilePath: file })).toMatchObject({
      enabled: false,
      filePath: file,
    });

    recorder.output('visible\r\n');
    recorder.setState({ paused: true });
    recorder.output('secret\r\n');
    recorder.setState({ paused: false, captureInput: true });
    recorder.input(Buffer.from('ls\r'));
    expect(recorder.setState({ logToFile: false })).toMatchObject({
      paused: false,
      filePath: undefined,
    });
    recorder.output('after stop\r\n');

    const text = await fileText(file, 'stopped');
    expect(text).toContain('visible\nSession logging paused.\nSession logging resumed.\n');
    expect(text).toContain('Input recording enabled.\nls');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('after stop');
    expect(recorder.state.sessionId).toBeUndefined();
  });

  it('keeps history and the log file apart', async () => {
    const recorder = await openRecorder({ enabled: true });
    const file = path.join(directory, 'both.log');
    recorder.setState({ logToFile: true, logFilePath: file });
    recorder.output('shared output\r\n');
    recorder.setState({ paused: true });
    // Starting history again keeps a paused log file paused.
    recorder.setState({ enabled: false });
    expect(recorder.state).toMatchObject({ enabled: false, paused: true });
    recorder.setState({ enabled: true });
    expect(recorder.state).toMatchObject({ enabled: true, paused: true });
    recorder.output('hidden\r\n');
    recorder.end('completed');

    const text = await fileText(file, 'ended');
    expect(text).toContain('shared output\n');
    expect(text).not.toContain('Session logging started.');
    expect(text).not.toContain('hidden');
    const detail = (await history!.sessionLog(recorder.state.sessionId!))!;
    const transcript = detail.events.map((event) => event.text).join('');
    expect(transcript).toContain('Session logging paused.');
    expect(transcript).not.toContain('Logging to file');
    expect(transcript).not.toContain('hidden');
  });

  it('warns instead of failing the session when the file cannot be written', async () => {
    const recorder = await openRecorder();
    const blocked = path.join(directory, 'blocked');
    writeFileSync(blocked, '');
    const state = recorder.setState({
      logToFile: true,
      logFilePath: path.join(blocked, 'session.log'),
    });
    expect(state.filePath).toBeUndefined();
    expect(state.warning).toMatch(/Could not write the log file/);
    recorder.output('still running\r\n');
    recorder.end('completed');
  });

  it('numbers generated names instead of reusing a file', async () => {
    const first = await openRecorder({ logToFile: true });
    const second = SessionRecorder.start(
      database!,
      history!,
      { warn: vi.fn() } as never,
      { kind: 'ssh', target: 'router1' },
    );
    expect(first.state.filePath).toBe(path.join(directory, 'router1.log'));
    expect(second.state.filePath).toBe(path.join(directory, 'router1-1.log'));
    first.end('completed');
    second.end('completed');
    await fileText(path.join(directory, 'router1-1.log'), 'ended');
    expect(readdirSync(directory).sort()).toEqual(['router1-1.log', 'router1.log']);
  });
});
