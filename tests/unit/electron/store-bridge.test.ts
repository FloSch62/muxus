import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createStoreBridge } from '../../../electron/src/store-bridge.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

function setup(handle = Buffer.from('7856341200000000', 'hex')) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const bridge = createStoreBridge('C:\\Muxus\\store-updater.exe', () => handle);
  return { child, bridge };
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('passes the native owner handle without a shell and handles split JSON lines', async () => {
  const { child, bridge } = setup();
  const progress = vi.fn();
  const result = bridge.run('check', progress);
  expect(spawn).toHaveBeenCalledWith('C:\\Muxus\\store-updater.exe', ['check', '305419896'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.write('{"status":"avail');
  child.stdout.write('able"}\n');
  child.emit('close', 0);
  await expect(result).resolves.toBe('available');
  expect(progress).not.toHaveBeenCalled();
});

it('reports installation progress and cancellation with a 32-bit handle', async () => {
  const { child, bridge } = setup(Buffer.from('78563412', 'hex'));
  const progress = vi.fn();
  const result = bridge.run('install', progress);
  child.stdout.write('{"status":"installing","percent":42.9}\n{"status":"canceled"}\n');
  child.emit('close', 0);
  await expect(result).resolves.toBe('canceled');
  expect(progress).toHaveBeenCalledExactlyOnceWith(42);
});

it.each(['not json', '{"status":"error"}', '{"status":"updated"}', '{"status":"installing","percent":1}'])('rejects invalid check responses: %s', async (message) => {
  const { child, bridge } = setup();
  const result = bridge.run('check', vi.fn());
  child.stdout.write(message + '\n');
  child.emit('close', 0);
  await expect(result).rejects.toThrow();
});

it.each([0, 1, null])('rejects exit %s without a valid response', async (code) => {
  const { child, bridge } = setup();
  const result = bridge.run('check', vi.fn());
  child.stderr.write('HRESULT 0x80004005');
  child.emit('close', code);
  await expect(result).rejects.toThrow('HRESULT 0x80004005');
});

it('reports a missing helper and rejects a missing owner window', async () => {
  const { child, bridge } = setup();
  const result = bridge.run('check', vi.fn());
  child.emit('error', new Error('ENOENT'));
  await expect(result).rejects.toThrow('ENOENT');
  const noWindow = createStoreBridge('helper.exe', () => { throw new Error('window closed'); });
  await expect(noWindow.run('install', vi.fn())).rejects.toThrow('window closed');
});

it('times out checks, but permits a user to take time confirming an installation', async () => {
  vi.useFakeTimers();
  const { child, bridge } = setup();
  const result = bridge.run('check', vi.fn());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit('close', null);
  await expect(result).rejects.toThrow('timed out');
  const install = setup();
  const installation = install.bridge.run('install', vi.fn());
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(install.child.kill).not.toHaveBeenCalled();
  install.child.stdout.write('{"status":"updated"}\n');
  install.child.emit('close', 0);
  await expect(installation).resolves.toBe('updated');
});
