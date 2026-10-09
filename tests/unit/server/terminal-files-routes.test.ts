import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedTransferFile } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'terminal-files-route-test-token';
let built: Awaited<ReturnType<typeof buildApp>>;
let home: string;

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'muxus-terminal-files-'));
  vi.stubEnv('HOME', home);
  built = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  );
});

afterEach(async () => {
  await built.app.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

const upload = (name: string, body: Buffer) =>
  built.app.inject({
    method: 'POST',
    url: `/api/terminal-files?name=${encodeURIComponent(name)}`,
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    payload: body,
  });

describe('/api/terminal-files', () => {
  it('stages an upload under a random id and keeps only the base name', async () => {
    const body = Buffer.from([0, 1, 2, 255, 13, 10]);
    const response = await upload('../../etc/firmware.img', body);
    expect(response.statusCode).toBe(201);
    const staged = response.json<StagedTransferFile>();
    expect(staged).toMatchObject({ name: 'firmware.img', size: 6 });
    const stored = built.ctx.transferFiles.get(staged.id)!;
    expect(path.basename(stored.path)).toBe(staged.id);
    expect(stored.path.startsWith(os.tmpdir())).toBe(true);
  });

  it('hands a staged file out once', async () => {
    const body = Buffer.from('received bytes');
    const { id } = (await upload('report.bin', body)).json<StagedTransferFile>();
    const first = await built.app.inject({ method: 'GET', url: `/api/terminal-files/${id}`, headers: auth });
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload).toEqual(body);
    expect(first.headers['content-disposition']).toBe('attachment; filename="report.bin"');
    await vi.waitFor(() => expect(built.ctx.transferFiles.get(id)).toBeUndefined());
    const second = await built.app.inject({ method: 'GET', url: `/api/terminal-files/${id}`, headers: auth });
    expect(second.statusCode).toBe(404);
  });

  it('discards a staged file on request', async () => {
    const { id } = (await upload('a.bin', Buffer.from('x'))).json<StagedTransferFile>();
    const response = await built.app.inject({ method: 'DELETE', url: `/api/terminal-files/${id}`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(built.ctx.transferFiles.get(id)).toBeUndefined();
  });

  it('rejects missing names, bad ids and missing credentials', async () => {
    expect(
      (
        await built.app.inject({
          method: 'POST',
          url: '/api/terminal-files',
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          payload: Buffer.from('x'),
        })
      ).statusCode,
    ).toBe(400);
    expect((await built.app.inject({ method: 'GET', url: '/api/terminal-files/..%2Fetc', headers: auth })).statusCode).toBe(400);
    expect((await built.app.inject({ method: 'GET', url: '/api/terminal-files/abc' })).statusCode).toBe(401);
  });
});
