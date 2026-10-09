import { mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  desktopExecArgument,
  GENERATED_DESKTOP_ID,
  generatedDesktopEntry,
  INSTALLED_DESKTOP_ID,
  LinuxLinkHandlers,
  SystemLinkHandlers,
  withoutAppImagePaths,
  type CommandRunner,
  type ProtocolClientApi,
} from '../../../electron/src/link-handlers.js';
import {
  parseKeyFileGroup,
  splitExec,
  unescapeDesktopString,
} from '../../../electron/src/linux-applications.js';

let root: string;
let dataHome: string;
let systemData: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'muxus-link-handlers-'));
  dataHome = path.join(root, 'data');
  systemData = path.join(root, 'system');
  await mkdir(path.join(systemData, 'applications'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** xdg-mime stand-in over an in-memory mimeapps.list. */
function fakeXdgMime(defaults: Map<string, string>, calls: string[][] = []): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command !== 'xdg-mime') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (args[0] === 'query' && args[1] === 'default') return `${defaults.get(args[2]!) ?? ''}\n`;
    if (args[0] === 'default') {
      defaults.set(args[2]!, args[1]!);
      return '';
    }
    throw new Error(`unexpected xdg-mime ${args.join(' ')}`);
  };
}

function handlers(
  run: CommandRunner,
  options: { command?: string[]; installed?: boolean; aliasDirectory?: string } = {},
): LinuxLinkHandlers {
  return new LinuxLinkHandlers({
    env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: systemData },
    home: root,
    command: options.command ?? ['/home/me/Apps/Muxus 0.10.0.AppImage'],
    installed: options.installed ?? false,
    aliasDirectory: options.aliasDirectory,
    run,
  });
}

function execArguments(entry: string): string[] | undefined {
  return splitExec(unescapeDesktopString(parseKeyFileGroup(entry, 'Desktop Entry').get('Exec') ?? ''));
}

describe('generated desktop entry', () => {
  it('quotes every launch argument so it reads back unchanged', () => {
    const command = [
      '/home/me/Apps/Muxus 0.10.0.AppImage',
      '/opt/odd "quoted" $HOME `tick` back\\slash 100%',
      '--no-sandbox',
    ];
    const entry = generatedDesktopEntry(command, ['ssh']);
    expect(execArguments(entry)).toEqual([
      command[0],
      '/opt/odd "quoted" $HOME `tick` back\\slash 100%%',
      '--no-sandbox',
      '%u',
    ]);
  });

  it('claims only the chosen schemes and stays out of menus', () => {
    const values = parseKeyFileGroup(generatedDesktopEntry(['/usr/bin/muxus'], ['ssh']), 'Desktop Entry');
    expect(values.get('MimeType')).toBe('x-scheme-handler/ssh;');
    expect(values.get('NoDisplay')).toBe('true');
    expect(values.get('Exec')).toBe('/usr/bin/muxus %u');
    expect(
      parseKeyFileGroup(generatedDesktopEntry(['/usr/bin/muxus'], ['ssh', 'telnet']), 'Desktop Entry').get(
        'MimeType',
      ),
    ).toBe('x-scheme-handler/ssh;x-scheme-handler/telnet;');
  });

  it('refuses paths that would break the file apart', () => {
    expect(() => desktopExecArgument('/tmp/a\nExec=evil')).toThrow();
    expect(desktopExecArgument('/opt/Muxus/muxus')).toBe('/opt/Muxus/muxus');
  });
});

describe('AppImage environment', () => {
  it('keeps the AppImage mount away from xdg-mime', () => {
    const mount = '/tmp/.mount_Muxus 1BHZoT';
    expect(
      withoutAppImagePaths({
        APPIMAGE: '/home/me/Muxus Test.AppImage',
        APPDIR: mount,
        PATH: `${mount}:${mount}/usr/sbin:/usr/bin:/bin`,
        XDG_DATA_DIRS: `${mount}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`,
        LD_LIBRARY_PATH: `${mount}/usr/lib`,
        HOME: '/home/me',
      }),
    ).toEqual({
      APPIMAGE: '/home/me/Muxus Test.AppImage',
      APPDIR: mount,
      PATH: '/usr/bin:/bin',
      XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/',
      HOME: '/home/me',
    });
  });

  it('leaves other builds alone', () => {
    const env = { PATH: '/usr/bin', XDG_DATA_DIRS: '/usr/share', APPDIR: '/opt/app' };
    expect(withoutAppImagePaths(env)).toBe(env);
  });
});

describe('Linux link handler registration', () => {
  it('reports the current handlers by name without changing anything', async () => {
    await writeFile(
      path.join(systemData, 'applications', 'putty.desktop'),
      '[Desktop Entry]\nType=Application\nName=PuTTY SSH Client\nExec=putty %u\n',
    );
    const defaults = new Map([['x-scheme-handler/ssh', 'putty.desktop']]);
    const calls: string[][] = [];
    const state = await handlers(fakeXdgMime(defaults, calls)).state();
    expect(state).toEqual({
      ssh: { isDefault: false, currentHandler: 'PuTTY SSH Client' },
      telnet: { isDefault: false },
    });
    expect(calls.every(([, action]) => action === 'query')).toBe(true);
  });

  it('points an AppImage registration at the AppImage file', async () => {
    const defaults = new Map<string, string>();
    const linux = handlers(fakeXdgMime(defaults));
    const result = await linux.register('ssh');
    expect(result.error).toBeUndefined();
    expect(defaults.get('x-scheme-handler/ssh')).toBe(GENERATED_DESKTOP_ID);
    expect(defaults.has('x-scheme-handler/telnet')).toBe(false);
    const entry = await readFile(path.join(dataHome, 'applications', GENERATED_DESKTOP_ID), 'utf8');
    expect(execArguments(entry)).toEqual(['/home/me/Apps/Muxus 0.10.0.AppImage', '%u']);
    expect(parseKeyFileGroup(entry, 'Desktop Entry').get('MimeType')).toBe('x-scheme-handler/ssh;');
    expect(result.state.ssh).toEqual({ isDefault: true, currentHandler: 'Muxus' });
    expect(result.state.telnet.isDefault).toBe(false);

    // Adding telnet keeps ssh claimed.
    const both = await linux.register('telnet');
    expect(both.state.ssh.isDefault && both.state.telnet.isDefault).toBe(true);
    const updated = await readFile(path.join(dataHome, 'applications', GENERATED_DESKTOP_ID), 'utf8');
    expect(parseKeyFileGroup(updated, 'Desktop Entry').get('MimeType')).toBe(
      'x-scheme-handler/ssh;x-scheme-handler/telnet;',
    );
  });

  it('notices a moved AppImage and registers the new location', async () => {
    const defaults = new Map<string, string>();
    await handlers(fakeXdgMime(defaults)).register('ssh');
    const moved = handlers(fakeXdgMime(defaults), { command: ['/opt/apps/Muxus.AppImage'] });
    expect((await moved.state()).ssh).toEqual({ isDefault: false, currentHandler: 'Another copy of Muxus' });
    expect((await moved.register('ssh')).state.ssh.isDefault).toBe(true);
  });

  it('reaches an AppImage whose path needs quoting through a plain link', async () => {
    const apps = path.join(root, 'My Apps');
    await mkdir(apps);
    const appImage = path.join(apps, 'Muxus 0.10.0.AppImage');
    await writeFile(appImage, '');
    const aliasDirectory = path.join(root, 'userdata');
    const defaults = new Map<string, string>();
    const linux = handlers(fakeXdgMime(defaults), { command: [appImage], aliasDirectory });

    const result = await linux.register('ssh');
    const alias = path.join(aliasDirectory, 'muxus-link-handler');
    const entry = await readFile(path.join(dataHome, 'applications', GENERATED_DESKTOP_ID), 'utf8');
    // xdg-utils reads the first space-separated word of Exec as the program.
    expect(parseKeyFileGroup(entry, 'Desktop Entry').get('Exec')).toBe(`${alias} %u`);
    expect(await readlink(alias)).toBe(appImage);
    expect(result.state.ssh.isDefault).toBe(true);

    // Moving the AppImage leaves the link dangling, so the choice is offered again.
    await rename(appImage, `${appImage}.moved`);
    expect((await linux.state()).ssh.isDefault).toBe(false);
  });

  it('uses the desktop file a package installed', async () => {
    await writeFile(
      path.join(systemData, 'applications', INSTALLED_DESKTOP_ID),
      '[Desktop Entry]\nType=Application\nName=Muxus\nExec=/opt/Muxus/muxus %U\nMimeType=x-scheme-handler/ssh;x-scheme-handler/telnet;\n',
    );
    const defaults = new Map<string, string>();
    const calls: string[][] = [];
    const linux = handlers(fakeXdgMime(defaults, calls), { command: ['/opt/Muxus/muxus'], installed: true });
    const result = await linux.register('telnet');
    expect(calls).toContainEqual(['xdg-mime', 'default', INSTALLED_DESKTOP_ID, 'x-scheme-handler/telnet']);
    expect(result.state.telnet).toEqual({ isDefault: true, currentHandler: 'Muxus' });
    await expect(readFile(path.join(dataHome, 'applications', GENERATED_DESKTOP_ID))).rejects.toThrow();
  });

  it('falls back to its own entry when the package entry is missing', async () => {
    const defaults = new Map<string, string>();
    const linux = handlers(fakeXdgMime(defaults), { command: ['/opt/Muxus/muxus'], installed: true });
    await linux.register('ssh');
    expect(defaults.get('x-scheme-handler/ssh')).toBe(GENERATED_DESKTOP_ID);
  });

  it('explains a missing xdg-mime', async () => {
    const missing: CommandRunner = () => Promise.reject(Object.assign(new Error('spawn xdg-mime ENOENT'), { code: 'ENOENT' }));
    const state = await handlers(missing).state();
    expect(state.unavailable).toMatch(/xdg-utils/);
    expect((await handlers(missing).register('ssh')).error).toMatch(/xdg-utils/);
  });

  it('reports a desktop that ignores the choice', async () => {
    const stubborn: CommandRunner = async (_command, args) => (args[0] === 'query' ? 'putty.desktop\n' : '');
    const result = await handlers(stubborn).register('ssh');
    expect(result.error).toMatch(/did not accept/);
    expect(result.state.ssh.isDefault).toBe(false);
  });
});

function fakeApi(overrides: Partial<ProtocolClientApi> = {}): ProtocolClientApi & { registered: unknown[][] } {
  const registered: unknown[][] = [];
  return {
    registered,
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: (...args) => {
      registered.push(args);
      return true;
    },
    getApplicationNameForProtocol: () => '',
    getApplicationInfoForProtocol: () => Promise.reject(new Error('no handler')),
    ...overrides,
  };
}

describe('macOS and Windows link handler registration', () => {
  const executable = 'C:\\Users\\me\\AppData\\Local\\Programs\\Muxus\\Muxus.exe';

  it('reads Launch Services on macOS', async () => {
    const api = fakeApi({
      isDefaultProtocolClient: (scheme) => scheme === 'ssh',
      getApplicationNameForProtocol: (url) => (url === 'ssh://' ? 'Muxus' : 'Terminal'),
    });
    const mac = new SystemLinkHandlers({
      platform: 'darwin',
      api,
      windowsStore: false,
      executable: '/Applications/Muxus.app/Contents/MacOS/Muxus',
      openDefaultAppsSettings: () => Promise.reject(new Error('macOS has no such page')),
    });
    expect(await mac.state()).toEqual({
      ssh: { isDefault: true, currentHandler: 'Muxus' },
      telnet: { isDefault: false, currentHandler: 'Terminal' },
    });
  });

  it('registers the running executable on Windows and checks what Windows resolves', async () => {
    let handlerPath = 'C:\\Program Files\\PuTTY\\putty.exe';
    const api = fakeApi({
      setAsDefaultProtocolClient: (...args) => {
        api.registered.push(args);
        handlerPath = executable.toUpperCase();
        return true;
      },
      getApplicationInfoForProtocol: async () => ({ path: handlerPath, name: 'x' }),
    });
    const windows = new SystemLinkHandlers({
      platform: 'win32',
      api,
      windowsStore: false,
      executable,
      openDefaultAppsSettings: () => Promise.reject(new Error('must not open settings')),
    });
    expect((await windows.state()).ssh.isDefault).toBe(false);
    const result = await windows.register('ssh');
    expect(api.registered).toEqual([['ssh']]);
    expect(result).toMatchObject({ state: { ssh: { isDefault: true } } });
    expect(result.openedSystemSettings).toBeUndefined();
  });

  it('opens Default apps when the user’s own choice outranks the registration', async () => {
    let opened = 0;
    const windows = new SystemLinkHandlers({
      platform: 'win32',
      api: fakeApi({
        getApplicationInfoForProtocol: async () => ({ path: 'C:\\PuTTY\\putty.exe', name: 'PuTTY' }),
      }),
      windowsStore: false,
      executable,
      openDefaultAppsSettings: async () => {
        opened++;
      },
    });
    expect(await windows.register('telnet')).toMatchObject({ openedSystemSettings: true });
    expect(opened).toBe(1);
  });

  it('leaves the registry alone for a Store package', async () => {
    const api = fakeApi();
    let opened = 0;
    const store = new SystemLinkHandlers({
      platform: 'win32',
      api,
      windowsStore: true,
      executable,
      openDefaultAppsSettings: async () => {
        opened++;
      },
    });
    expect(await store.register('ssh')).toMatchObject({ openedSystemSettings: true });
    expect(api.registered).toEqual([]);
    expect(opened).toBe(1);
  });

  it('registers a source checkout as Electron plus the app directory', async () => {
    const api = fakeApi({ isDefaultProtocolClient: () => true });
    const development = new SystemLinkHandlers({
      platform: 'darwin',
      api,
      windowsStore: false,
      development: { executable: '/src/node_modules/electron/dist/Electron', appPath: '/src/electron' },
      executable: '/src/node_modules/electron/dist/Electron',
      openDefaultAppsSettings: async () => undefined,
    });
    await development.register('ssh');
    expect(api.registered).toEqual([['ssh', '/src/node_modules/electron/dist/Electron', ['/src/electron']]]);
  });
});
