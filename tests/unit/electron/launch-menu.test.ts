import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  APP_USER_MODEL_ID,
  dockMenuEntries,
  jumpListCategories,
  recentLaunches,
  windowsArgument,
  type RecentLaunches,
} from '../../../electron/src/launch-menu.js';

const at = (minute: number) => `2026-10-26 09:${String(minute).padStart(2, '0')}:00`;
const launcher = { program: 'C:\\Program Files\\Muxus\\Muxus.exe', args: [] };

function hosts(count: number): RecentLaunches['hosts'] {
  return Array.from({ length: count }, (_, index) => ({
    title: `edge-${index + 1}`,
    launch: { kind: 'host' as const, name: `edge-${index + 1}` },
  }));
}

function workspaces(count: number): RecentLaunches['workspaces'] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Shift ${index + 1}`,
    launch: { kind: 'workspace' as const, name: `ws-${index + 1}` },
  }));
}

describe('recent hosts and workspaces', () => {
  it('orders hosts from both sources by their last connection', () => {
    const recent = recentLaunches(
      [
        { alias: 'core-1', metadata: { lastConnectedAt: at(10) } },
        { alias: 'edge-1', metadata: { lastConnectedAt: at(30), displayName: 'Edge Paris' } },
        { alias: 'never-used', metadata: { displayName: 'Unused' } },
        { alias: 'no-metadata' },
      ],
      [
        { id: 'saved-1', name: 'Console 1', metadata: { lastConnectedAt: at(20) } },
        { id: 'saved-2', name: 'Console 2', metadata: {} },
      ],
      [],
    );
    expect(recent.hosts).toEqual([
      { title: 'Edge Paris', launch: { kind: 'host', name: 'edge-1' } },
      { title: 'Console 1', launch: { kind: 'host', name: 'saved-1' } },
      { title: 'core-1', launch: { kind: 'host', name: 'core-1' } },
    ]);
  });

  it('launches saved hosts by ID, so a rename keeps the entry working', () => {
    const recent = recentLaunches(
      [],
      [{ id: 'saved-1', name: 'Renamed', metadata: { displayName: 'Lab console', lastConnectedAt: at(1) } }],
      [],
    );
    expect(recent.hosts).toEqual([{ title: 'Lab console', launch: { kind: 'host', name: 'saved-1' } }]);
  });

  it('lists an alias from several ssh_config blocks once', () => {
    const block = { alias: 'edge-1', metadata: { lastConnectedAt: at(5) } };
    expect(recentLaunches([block, { ...block }], [], []).hosts).toHaveLength(1);
  });

  it('orders workspaces by last opening, else last change, and opens them by ID', () => {
    const recent = recentLaunches(
      [],
      [],
      [
        { id: 'ws-old', name: 'Old', updatedAt: at(1), lastOpenedAt: at(2) },
        { id: 'ws-saved', name: 'Never opened', updatedAt: at(40) },
        { id: 'ws-night', name: 'Night shift', updatedAt: at(3), lastOpenedAt: at(50) },
      ],
    );
    expect(recent.workspaces).toEqual([
      { title: 'Night shift', launch: { kind: 'workspace', name: 'ws-night' } },
      { title: 'Never opened', launch: { kind: 'workspace', name: 'ws-saved' } },
      { title: 'Old', launch: { kind: 'workspace', name: 'ws-old' } },
    ]);
  });
});

describe('Windows command-line arguments', () => {
  it('quotes only what CommandLineToArgvW would split or unquote', () => {
    expect(windowsArgument('--host=edge-1')).toBe('--host=edge-1');
    expect(windowsArgument('--host=core sw 1')).toBe('"--host=core sw 1"');
    expect(windowsArgument('C:\\Users\\Jane Doe\\muxus\\electron')).toBe('"C:\\Users\\Jane Doe\\muxus\\electron"');
    expect(windowsArgument('a"b')).toBe('"a\\"b"');
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsArgument('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
    expect(windowsArgument('')).toBe('""');
  });
});

describe('taskbar jump list', () => {
  it('lists recent hosts and workspaces above the New window task', () => {
    const categories = jumpListCategories(
      { hosts: hosts(1), workspaces: workspaces(1) },
      launcher,
      new Set(),
    );
    const entry = { type: 'task', program: launcher.program, iconPath: launcher.program, iconIndex: 0 };
    expect(categories).toEqual([
      {
        type: 'custom',
        name: 'Recent hosts',
        items: [{ ...entry, title: 'edge-1', description: 'Connect to edge-1', args: '--host=edge-1' }],
      },
      {
        type: 'custom',
        name: 'Recent workspaces',
        items: [
          { ...entry, title: 'Shift 1', description: 'Open workspace Shift 1', args: '--workspace=ws-1' },
        ],
      },
      {
        type: 'tasks',
        items: [{ ...entry, title: 'New window', description: 'Open a new Muxus window', args: '--new-window' }],
      },
    ]);
  });

  it('keeps five hosts and three workspaces', () => {
    const [recentHosts, recentWorkspaces] = jumpListCategories(
      { hosts: hosts(8), workspaces: workspaces(6) },
      launcher,
      new Set(),
    );
    expect(recentHosts?.items.map((item) => item.title)).toEqual(['edge-1', 'edge-2', 'edge-3', 'edge-4', 'edge-5']);
    expect(recentWorkspaces?.items.map((item) => item.title)).toEqual(['Shift 1', 'Shift 2', 'Shift 3']);
  });

  it('leaves out entries the user removed and fills the place with the next one', () => {
    const [recentHosts] = jumpListCategories(
      { hosts: hosts(6), workspaces: [] },
      launcher,
      new Set(['--host=edge-2']),
    );
    expect(recentHosts?.items.map((item) => item.args)).toEqual([
      '--host=edge-1',
      '--host=edge-3',
      '--host=edge-4',
      '--host=edge-5',
      '--host=edge-6',
    ]);
  });

  it('shows only the New window task until something has been used', () => {
    expect(jumpListCategories({ hosts: [], workspaces: [] }, launcher, new Set())).toEqual([
      expect.objectContaining({ type: 'tasks' }),
    ]);
  });

  it('starts Electron with the app folder from a source checkout', () => {
    const [recentHosts] = jumpListCategories(
      { hosts: [{ title: 'core sw', launch: { kind: 'host', name: 'core sw' } }], workspaces: [] },
      { program: 'C:\\src\\node_modules\\electron\\dist\\electron.exe', args: ['C:\\Users\\Jane Doe\\muxus\\electron'] },
      new Set(),
    );
    expect(recentHosts?.items[0]?.args).toBe('"C:\\Users\\Jane Doe\\muxus\\electron" "--host=core sw"');
  });

  it('shortens a tooltip Windows would reject', () => {
    const [recentHosts] = jumpListCategories(
      { hosts: [{ title: 'x'.repeat(300), launch: { kind: 'host', name: 'long' } }], workspaces: [] },
      launcher,
      new Set(),
    );
    expect(recentHosts?.items[0]?.description).toHaveLength(260);
  });

  it('uses the AppUserModelID the installer gives its shortcuts', async () => {
    const config = await readFile(new URL('../../../electron/electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replaceAll('.', '\\.')}$`, 'm'));
  });
});

describe('macOS Dock menu', () => {
  it('offers New Window, then recent hosts and workspaces under headings', () => {
    expect(dockMenuEntries({ hosts: hosts(1), workspaces: workspaces(1) })).toEqual([
      { label: 'New Window', launch: { kind: 'new-window' } },
      { type: 'separator' },
      { label: 'Recent Hosts', enabled: false },
      { label: 'edge-1', launch: { kind: 'host', name: 'edge-1' } },
      { type: 'separator' },
      { label: 'Recent Workspaces', enabled: false },
      { label: 'Shift 1', launch: { kind: 'workspace', name: 'ws-1' } },
    ]);
  });

  it('keeps five hosts and three workspaces and drops empty sections', () => {
    const launches = (recent: RecentLaunches) =>
      dockMenuEntries(recent).flatMap((entry) => ('launch' in entry ? [entry.launch.kind] : []));
    expect(launches({ hosts: hosts(7), workspaces: workspaces(4) })).toEqual([
      'new-window',
      ...Array<string>(5).fill('host'),
      ...Array<string>(3).fill('workspace'),
    ]);
    expect(dockMenuEntries({ hosts: [], workspaces: [] })).toEqual([
      { label: 'New Window', launch: { kind: 'new-window' } },
    ]);
  });
});
