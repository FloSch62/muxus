import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLogSummary } from '@muxus/shared';
import {
  historyCompareLabel,
  historyCompareText,
  remoteFileCompareText,
  terminalCompareText,
} from '../../../client/src/compare-sources.js';

const session: SessionLogSummary = {
  id: 'log-1',
  profileKey: 'ssh:core-1',
  title: 'admin@core-1',
  kind: 'ssh',
  host: 'core-1',
  startedAt: '2026-10-14T12:00:00.000Z',
  status: 'completed',
  paused: false,
  captureInput: false,
  eventCount: 3,
  rawBytes: 10,
  normalizedBytes: 10,
  partCount: 1,
  pinned: false,
};

/** Answers every request with `response`; the stub records the URLs it was called with. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('historyCompareLabel', () => {
  it('names a record by its label, else its title, followed by the start time', () => {
    const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(
      new Date(session.startedAt),
    );
    expect(historyCompareLabel(session)).toBe(`admin@core-1 · ${time}`);
    expect(historyCompareLabel({ ...session, label: 'core-1 before' })).toBe(`core-1 before · ${time}`);
  });
});

describe('terminalCompareText', () => {
  it('labels a terminal output and a selection apart', () => {
    expect(terminalCompareText('core-1', 'show version\n', false)).toEqual({
      label: 'core-1 (terminal output)',
      text: 'show version\n',
    });
    expect(terminalCompareText('core-1', 'Gi0/1 up', true)).toEqual({
      label: 'core-1 (selection)',
      text: 'Gi0/1 up',
    });
  });
});

describe('historyCompareText', () => {
  it('reads the record as its clean log', async () => {
    const fetchMock = stubFetch(new Response('show version\nIOS 15.2\n', { status: 200 }));
    await expect(historyCompareText(session)).resolves.toEqual({
      label: historyCompareLabel(session),
      text: 'show version\nIOS 15.2\n',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session-history/log-1/clean');
  });

  it('rejects with the server message when the record is gone', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'session log not found' }), { status: 404 }));
    await expect(historyCompareText(session)).rejects.toThrow('session log not found');
  });
});

describe('remoteFileCompareText', () => {
  it('reads the file over SFTP with its path encoded and keeps where it came from', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ path: '/var/log/my file&1.log', content: 'up\n', size: 3 }), { status: 200 }),
    );
    await expect(remoteFileCompareText('conn-1', 'core-1', '/var/log/my file&1.log')).resolves.toEqual({
      label: 'core-1:/var/log/my file&1.log',
      text: 'up\n',
      remote: { connId: 'conn-1', host: 'core-1', path: '/var/log/my file&1.log' },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sftp/conn-1/file?path=%2Fvar%2Flog%2Fmy%20file%261.log');
  });

  it('rejects with the server message for a file that is not UTF-8 text', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'the remote editor currently supports UTF-8 text files' }), {
        status: 415,
      }),
    );
    await expect(remoteFileCompareText('conn-1', 'core-1', '/var/log/fw.bin')).rejects.toThrow('UTF-8 text files');
  });
});
