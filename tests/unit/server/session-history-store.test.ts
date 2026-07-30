import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHistorySettings } from '@muxus/shared';
import { SessionHistoryStore } from '../../../server/src/session-logging/history-store.js';

const settings: SessionHistorySettings = {
  maxTotalBytes: 5 * 1024 ** 3,
  minFreeBytes: 0,
  minFreePercent: 0,
};

let store: SessionHistoryStore | undefined;
let root: string | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('hybrid session history store', () => {
  it('rotates compressed raw segments and searches normalized chunks', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-test-'));
    store = await SessionHistoryStore.open({ root, settings });
    const policy = { maxPartBytes: 64 * 1024, maxParts: 2 };
    const id = store.beginSession(
      {
        profileKey: 'ssh:edge',
        title: 'Edge router',
        kind: 'ssh',
        host: 'edge',
        startedAt: '2026-07-24T10:00:00.000Z',
        captureInput: false,
      },
      policy,
    );
    for (let sequence = 1; sequence <= 4; sequence++) {
      expect(store.append(
        id,
        [{
          sequence,
          recordedAt: `2026-07-24T10:00:0${sequence}.000Z`,
          elapsedMs: sequence * 1_000,
          direction: 'output',
          raw: Buffer.alloc(40 * 1024, sequence),
          text: sequence === 3 ? 'BGP neighbor established\n' : `event ${sequence}\n`,
        }],
        policy,
      )).toBe(true);
    }
    store.finishSession(id, 'completed', '2026-07-24T10:01:00.000Z');

    const detail = await store.sessionLog(id);
    expect(detail).toMatchObject({
      status: 'completed',
      eventCount: 2,
      partCount: 2,
      pinned: false,
    });
    expect(detail?.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect((await store.rawSessionLogEvents(id))?.map((event) => event.sequence))
      .toEqual([3, 4]);
    expect((await store.sessionHistory({ query: 'BGP established', limit: 20 })).sessions)
      .toEqual([expect.objectContaining({ id })]);
    expect((await store.sessionHistory({ query: 'event 1', limit: 20 })).sessions)
      .toEqual([]);

    const segmentFiles = readdirSync(path.join(root, 'sessions', id));
    expect(segmentFiles).toHaveLength(2);
    expect(segmentFiles.every((file) => file.endsWith('.muxlog.zst'))).toBe(true);
  });

  it('centers snippets on the match, counts matches, and anchors previews', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-test-'));
    store = await SessionHistoryStore.open({ root, settings });
    const policy = { maxPartBytes: 1024 * 1024, maxParts: 10 };
    const id = store.beginSession(
      {
        profileKey: 'ssh:lab',
        title: 'Lab switch',
        kind: 'ssh',
        host: 'lab',
        startedAt: '2026-07-25T10:00:00.000Z',
        captureInput: false,
      },
      policy,
    );
    const events = [];
    for (let sequence = 1; sequence <= 30; sequence++) {
      const text =
        sequence === 5
          ? 'ssh admin@192.168.7.44\n'
          : sequence === 12
            ? `${'padding '.repeat(60)}ping 192.168.7.44 ok\n`
            : `filler line ${sequence}\n`;
      events.push({
        sequence,
        recordedAt: `2026-07-25T10:00:${String(sequence).padStart(2, '0')}.000Z`,
        elapsedMs: sequence * 1_000,
        direction: 'output' as const,
        raw: Buffer.from(text),
        text,
      });
    }
    expect(store.append(id, events, policy)).toBe(true);
    store.finishSession(id, 'completed', '2026-07-25T10:01:00.000Z');

    // A partially typed IP matches as a prefix and reports every occurrence.
    const byIp = await store.sessionHistory({ query: '192.168.7', limit: 20 });
    expect(byIp.sessions).toEqual([
      expect.objectContaining({ id, matchCount: 2 }),
    ]);
    expect(byIp.sessions[0]!.snippet).toContain('\u0001192.168.7\u0002');

    // The excerpt centers on a match buried deep inside a long chunk instead
    // of showing the chunk's first characters.
    const byCommand = await store.sessionHistory({ query: 'ping', limit: 20 });
    expect(byCommand.sessions[0]!.snippet).toContain('\u0001ping\u0002');
    expect(byCommand.sessions[0]!.snippet).toContain('…');

    // Separator-only extra tokens carry no signal and must not empty the result.
    expect((await store.sessionHistory({ query: 'ping ->', limit: 20 })).sessions)
      .toHaveLength(1);

    // A limited preview opened from a search anchors on the first match with
    // leading context; without a query it keeps returning the newest events.
    const anchored = await store.sessionLog(id, 10, 'ping');
    expect(anchored?.eventsTruncated).toBe(true);
    expect(anchored?.events.some((event) => event.text.includes('ping'))).toBe(true);
    expect(anchored?.events[0]?.sequence).toBeLessThan(12);
    const newest = await store.sessionLog(id, 10);
    expect(newest?.events.map((event) => event.sequence)).toEqual(
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    );
  });

  it('keeps pinned sessions out of age retention and uses cursor pages', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-test-'));
    store = await SessionHistoryStore.open({ root, settings });
    const policy = { maxPartBytes: 1024 * 1024, maxParts: 2 };
    const ids: string[] = [];
    for (let day = 1; day <= 3; day++) {
      const id = store.beginSession(
        {
          profileKey: 'ssh:edge',
          title: `Day ${day}`,
          kind: 'ssh',
          host: 'edge',
          startedAt: `2020-01-0${day}T10:00:00.000Z`,
          captureInput: false,
        },
        policy,
      );
      store.append(id, [{
        sequence: 1,
        recordedAt: `2020-01-0${day}T10:00:01.000Z`,
        elapsedMs: 1_000,
        direction: 'output',
        raw: Buffer.from(`day ${day}`),
        text: `day ${day}\n`,
      }], policy);
      store.finishSession(id, 'completed', `2020-01-0${day}T10:01:00.000Z`);
      ids.push(id);
    }

    const first = await store.sessionHistory({ limit: 2 });
    expect(first.sessions.map((session) => session.title)).toEqual(['Day 3', 'Day 2']);
    expect(first.nextCursor).toBeTruthy();
    const second = await store.sessionHistory({ limit: 2, cursor: first.nextCursor });
    expect(second.sessions.map((session) => session.title)).toEqual(['Day 1']);

    expect(await store.setPinned(ids[0]!, true)).toBe(true);
    await store.updateSettings({ ...settings, maxAgeDays: 1 });
    expect((await store.sessionHistory({ limit: 10 })).sessions)
      .toEqual([expect.objectContaining({ id: ids[0], pinned: true })]);
    expect(await store.setPinned(ids[0]!, false)).toBe(true);
    expect((await store.sessionHistory({ limit: 10 })).sessions).toEqual([]);
  });

  it('never evicts an active session and reports quota suspension', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-test-'));
    store = await SessionHistoryStore.open({ root, settings });
    const policy = { maxPartBytes: 4 * 1024 * 1024, maxParts: 2 };
    const pinned = store.beginSession({
      profileKey: 'ssh:pinned',
      title: 'Pinned',
      kind: 'ssh',
      host: 'pinned',
      startedAt: '2026-01-01T10:00:00.000Z',
      captureInput: false,
    }, policy);
    store.append(pinned, [{
      sequence: 1,
      recordedAt: '2026-01-01T10:00:01.000Z',
      elapsedMs: 1_000,
      direction: 'output',
      raw: Buffer.from('keep me'),
      text: 'keep me\n',
    }], policy);
    store.finishSession(pinned, 'completed', '2026-01-01T10:01:00.000Z');
    await store.setPinned(pinned, true);

    const baseline = await store.storageStatus();
    await store.updateSettings({
      ...settings,
      // Direct worker-level test uses a deliberately tiny limit so the
      // behavior is exercised without allocating tens of MiB.
      maxTotalBytes: baseline.usageBytes + 512 * 1024,
    });
    const active = store.beginSession({
      profileKey: 'ssh:active',
      title: 'Active',
      kind: 'ssh',
      host: 'active',
      startedAt: '2026-01-02T10:00:00.000Z',
      captureInput: false,
    }, policy);
    const failure = new Promise<string>((resolve) => {
      store!.onSessionFailure(active, resolve);
    });
    expect(store.append(active, [{
      sequence: 1,
      recordedAt: '2026-01-02T10:00:01.000Z',
      elapsedMs: 1_000,
      direction: 'output',
      raw: randomBytes(1_200_000),
      text: 'large active event\n',
    }], policy)).toBe(true);

    await expect(failure).resolves.toMatch(/quota|free-space/i);
    expect(await store.storageStatus()).toMatchObject({ quotaSuspended: true });
    expect((await store.sessionHistory({ limit: 10 })).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pinned, pinned: true }),
        expect.objectContaining({ id: active, status: 'active' }),
      ]),
    );
  });

  it('truncates an incomplete final frame and marks a crash-interrupted session', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'muxus-history-test-'));
    store = await SessionHistoryStore.open({ root, settings });
    await store.close();
    store = undefined;

    const database = new DatabaseSync(path.join(root, 'session-history.sqlite'));
    database.prepare(`
      INSERT INTO session_logs(
        id, profile_key, title, kind, host, started_at, status,
        capture_input, event_count, raw_bytes, current_part, current_part_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 1, 5, 1, 5)
    `).run(
      'interrupted',
      'ssh:edge',
      'Interrupted',
      'ssh',
      'edge',
      '2026-01-01T10:00:00.000Z',
    );
    database.close();

    const directory = path.join(root, 'sessions', 'interrupted');
    mkdirSync(directory, { recursive: true });
    const segmentHeader = Buffer.from([
      0x4d, 0x55, 0x58, 0x4c, 0x4f, 0x47, 0x01, 0x0a,
    ]);
    const raw = Buffer.from('hello');
    const frame = Buffer.alloc(4 + 25 + raw.byteLength);
    frame.writeUInt32BE(25 + raw.byteLength, 0);
    frame.writeBigUInt64BE(1n, 4);
    frame.writeBigUInt64BE(BigInt(Date.parse('2026-01-01T10:00:01.000Z')), 12);
    frame.writeBigUInt64BE(1_000n, 20);
    frame[28] = 2;
    raw.copy(frame, 29);
    const incomplete = Buffer.alloc(7);
    incomplete.writeUInt32BE(100, 0);
    writeFileSync(
      path.join(directory, '000001.muxlog.partial'),
      Buffer.concat([segmentHeader, frame, incomplete]),
    );

    store = await SessionHistoryStore.open({ root, settings });
    expect(await store.sessionLog('interrupted')).toMatchObject({
      status: 'disconnected',
      partCount: 1,
    });
    expect((await store.rawSessionLogEvents('interrupted'))?.map((event) => event.raw))
      .toEqual([Buffer.from('hello')]);
    expect(readdirSync(directory)).toEqual(['000001.muxlog.zst']);
  });
});
