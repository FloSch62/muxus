import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const launcher = process.env.MUXUS_DESKTOP_LAUNCHER ?? path.join(repoRoot, `desktop/build/dev-linux-${process.arch}/Muxus-dev/bin/launcher`);
type Command = <T>(route: string, body?: unknown) => Promise<T>;

// W3C WebDriver drives the actual system WebKitGTK view, including native input.
// Serialize window selection with commands: independent windows share a session.
export class NativePage {
  private wheelPosition = { x: 0, y: 0 };
  constructor(readonly handle: string, private command: Command, private select: <T>(handle: string, action: () => Promise<T>) => Promise<T>) {}
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.select<R>(this.handle, async () => {
      const result = await this.command<{ value: R; error?: string }>('/execute/async', {
        script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (${fn.toString()})(arguments[0])).then(value => done({value: value ?? null}), error => done({error: String(error)}));`, args: [arg ?? null],
      });
      if (result.error) throw new Error(result.error);
      return result.value;
    });
  }
  async waitForFunction(fn: () => unknown): Promise<void> { await expect.poll(() => this.evaluate(fn)).toBeTruthy(); }
  async click(selector: string): Promise<void> {
    await this.select(this.handle, async () => {
      const element = await this.command<Record<string, string>>('/element', { using: 'css selector', value: selector });
      await this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    });
  }
  async moveTo(selector: string): Promise<void> {
    const point = await this.evaluate(css => { const r = document.querySelector(css)!.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, selector);
    await this.select(this.handle, () => this.command('/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', duration: 0, ...point }] }] }));
  }
  async drag(selector: string, deltaX: number, deltaY: number, steps = 60): Promise<void> {
    const point = await this.evaluate(css => { const r = document.querySelector(css)!.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, selector);
    await this.select(this.handle, () => this.command('/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', origin: 'viewport', duration: 0, ...point }, { type: 'pointerDown', button: 0 },
      ...Array.from({ length: steps }, (_, i) => ({ type: 'pointerMove', origin: 'viewport', duration: 16, x: Math.round(point.x + deltaX * (i + 1) / steps), y: Math.round(point.y + deltaY * (i + 1) / steps) })),
      { type: 'pointerUp', button: 0 },
    ] }] }));
  }
  async wheel(selector: string, deltaY: number, deltaX = 0): Promise<void> {
    const point = await this.evaluate(css => { const r = document.querySelector(css)!.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, selector);
    // WebKitGTK automation treats wheel deltas as axis positions: repeating
    // the same delta scrolls once, and a wheel-source pause reverses it.
    // Send a continuous trajectory and keep the source position across calls.
    const initial = { ...this.wheelPosition };
    this.wheelPosition = { x: initial.x + deltaX, y: initial.y + deltaY };
    await this.select(this.handle, () => this.command('/actions', { actions: [{ type: 'wheel', id: `wheel-${this.handle}`, actions: Array.from({ length: 120 }, (_, i) => ({ type: 'scroll', origin: 'viewport', duration: 16, deltaX: Math.round(initial.x + deltaX * (i + 1) / 120), deltaY: Math.round(initial.y + deltaY * (i + 1) / 120), ...point })) }] }));
  }
  async fill(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.press('Control+a');
    await this.press('Backspace');
    if (text) await this.select(this.handle, async () => {
      const element = await this.command<Record<string, string>>('/element', { using: 'css selector', value: selector });
      await this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
    });
  }
  async type(selector: string, text: string): Promise<void> {
    await this.select(this.handle, async () => {
      const element = await this.command<Record<string, string>>('/element', { using: 'css selector', value: selector });
      await this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
    });
  }
  async screenshot(file: string): Promise<void> {
    const data = await this.select(this.handle, () => this.command<string>('/screenshot'));
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
  async count(selector: string): Promise<number> { return this.evaluate((css) => document.querySelectorAll(css).length, selector); }
  async visible(selector: string): Promise<boolean> { return this.evaluate((css) => Array.from(document.querySelectorAll(css)).some((el) => el.getBoundingClientRect().height > 0), selector); }
  async url(): Promise<string> { return this.evaluate(() => location.href); }
  async reload(): Promise<void> { await this.select(this.handle, () => this.command('/refresh', {})); }
  async isClosed(): Promise<boolean> { return !(await this.command<string[]>('/window/handles')).includes(this.handle); }
  async press(chord: string): Promise<void> {
    const keys: Record<string, string> = { Backspace: '\uE003', Control: '\uE009', Shift: '\uE008', Alt: '\uE00A', Meta: '\uE03D', Tab: '\uE004', Escape: '\uE00C', ArrowDown: '\uE015', ArrowRight: '\uE014', Enter: '\uE007', Space: '\uE00D' };
    const values = chord.split('+').map((key) => keys[key] ?? key);
    await this.select(this.handle, () => this.command('/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [...values.map((value) => ({ type: 'keyDown', value })), ...values.toReversed().map((value) => ({ type: 'keyUp', value }))] }] }));
  }
}

export async function launchDesktop(options: { stateDir?: string; args?: string[] } = {}) {
  if (process.platform !== 'linux') throw new Error('Native automation requires Linux WebKitGTK and webkit2gtk-driver.');
  if (!existsSync(launcher)) throw new Error(`Desktop bundle missing: ${launcher}. Run pnpm --filter @muxus/desktop run pack.`);
  const stateDir = options.stateDir ?? mkdtempSync(path.join(tmpdir(), 'muxus-desktop-e2e-'));
  const userDataDir = path.join(stateDir, 'user-data');
  for (const folder of [userDataDir, path.join(stateDir, 'config'), path.join(stateDir, 'cache')]) mkdirSync(folder, { recursive: true });
  const sshConfig = path.join(stateDir, 'ssh-config');
  writeFileSync(sshConfig, '', { mode: 0o600 });
  const env = { ...process.env, MUXUS_DESKTOP_DATA: userDataDir, MUXUS_SSH_CONFIG: sshConfig, XDG_CONFIG_HOME: path.join(stateDir, 'config'), XDG_CACHE_HOME: path.join(stateDir, 'cache'), MUXUS_NO_OPEN: '1' };
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Missing driver port');
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.env.WEBKIT_WEBDRIVER ?? 'WebKitWebDriver', [`--port=${port}`], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.on('error', (error) => { output += String(error); });
  const base = `http://127.0.0.1:${port}`;
  const request = async <T>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json() as { value: T & { error?: string; message?: string } };
    if (!response.ok) throw new Error(`${route}: ${result.value.message || result.value.error}`);
    return result.value;
  };
  let sessionId: string | undefined;
  let stopped = false;
  const stopDriver = async () => {
    if (sessionId) await request(`/session/${sessionId}`, undefined, 'DELETE').catch(() => undefined);
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } }
    try {
      const pid = Number(readFileSync(path.join(userDataDir, 'runtime.pid'), 'utf8'));
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    } catch { /* Already stopped or startup failed before the runtime loaded. */ }
  };
  try {
    await expect.poll(async () => { try { await request('/status'); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
    // No browserName: WebKitGTK reports the app's identifier, not MiniBrowser.
    const session = await request<{ sessionId: string }>('/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary: launcher, args: ['--automation', ...(options.args ?? [])] } } } });
    sessionId = session.sessionId;
    const command: Command = (route, body) => request(`/session/${sessionId}${route}`, body);
    let queue: Promise<unknown> = Promise.resolve();
    const select = <T>(handle: string, action: () => Promise<T>): Promise<T> => {
      const pending = queue.then(async () => { await command('/window', { handle }); return action(); });
      queue = pending.catch(() => undefined);
      return pending;
    };
    const handles = () => command<string[]>('/window/handles');
    const page = new NativePage((await handles())[0]!, command, select);
    await page.waitForFunction(() => !!window.muxusDesktop);
    await expect.poll(() => page.url()).not.toContain('token=');
    await expect.poll(() => page.visible('button[aria-label="Settings"]')).toBe(true);
    const origin = new URL(await page.url()).origin;
    const launched = {
      page, stateDir, userDataDir, handles,
      launchAgain: (args: string[]) => spawn(launcher, args, { env, stdio: 'ignore' }),
      nativePage: (handle: string) => new NativePage(handle, command, select),
      async waitForWindow(windowId: string) {
        let found: NativePage | undefined;
        await expect.poll(async () => {
          for (const handle of await handles()) {
            const candidate = new NativePage(handle, command, select);
            if (await candidate.evaluate((id) => window.muxusDesktop?.windowLaunch?.title === id, windowId)) { found = candidate; return true; }
          }
          return false;
        }).toBe(true);
        return found!;
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          for (const handle of await handles()) {
            const target = new NativePage(handle, command, select);
            await target.evaluate(() => { setTimeout(() => window.muxusDesktop?.closeWindow(), 50); });
            await expect.poll(() => target.isClosed().catch(() => true)).toBe(true);
          }
          await expect.poll(async () => { try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } }).toBe(false);
        } finally { await stopDriver(); }
      },
      async close() { try { await launched.stop(); } finally { rmSync(stateDir, { recursive: true, force: true }); } },
    };
    return launched;
  } catch (error) {
    await stopDriver();
    writeFileSync(path.join(stateDir, 'launch.log'), output);
    throw new Error(`Electrobun launch failed; diagnostics: ${stateDir}/launch.log\n${String(error)}\n${output.slice(-3000)}`, { cause: error });
  }
}
