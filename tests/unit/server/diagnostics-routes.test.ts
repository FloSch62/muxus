import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionDiagnosticsResponse } from '@muxus/shared';
import { buildApp } from '../../../server/src/app.js';
import { resolveConfig } from '../../../server/src/config.js';

const TOKEN = 'diagnostics-route-test-token';
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let home: string;

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'muxus-diagnostics-routes-'));
  vi.stubEnv('HOME', home);
  ({ app } = await buildApp(
    resolveConfig({
      token: TOKEN,
      databasePath: ':memory:',
      openBrowser: false,
      prettyLogs: false,
      staticRoot: '/path/that/does/not/exist',
    }),
  ));
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const diagnose = (profile: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/diagnostics/connection',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { profile },
  });

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('POST /api/diagnostics/connection', () => {
  it('diagnoses a Telnet port nothing listens on', async () => {
    const port = await closedPort();
    const response = await diagnose({ kind: 'telnet', host: '127.0.0.1', port });
    expect(response.statusCode).toBe(200);
    const report = response.json<ConnectionDiagnosticsResponse>();
    expect(report.checked).toBe(`127.0.0.1:${port}`);
    expect(report.checks).toContainEqual({
      label: 'TCP',
      status: 'fail',
      detail: `127.0.0.1:${port} refused the connection`,
    });
    expect(report.conclusion).toMatch(/nothing accepts connections/);
  });

  it('reads the greeting of an ad-hoc SSH target', async () => {
    const server = net.createServer((socket) => socket.end('SSH-2.0-RouteTest\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const response = await diagnose({ kind: 'ssh', target: `alice@127.0.0.1:${port}` });
      expect(response.statusCode).toBe(200);
      const report = response.json<ConnectionDiagnosticsResponse>();
      expect(report.checks[0]).toEqual({
        label: 'Route',
        status: 'info',
        detail: `alice@127.0.0.1:${port}`,
      });
      expect(report.checks).toContainEqual({ label: 'SSH', status: 'ok', detail: 'SSH-2.0-RouteTest' });
    } finally {
      server.close();
    }
  });

  it('answers a dial plan that cannot be built with its reason', async () => {
    const response = await diagnose({ kind: 'ssh', target: 'gone', profileId: 'missing-profile' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ message: 'saved SSH profile "missing-profile" was not found' });
  });

  it('only diagnoses network sessions', async () => {
    const response = await diagnose({ kind: 'local' });
    expect(response.statusCode).toBe(400);
  });
});
