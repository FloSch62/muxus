import type {
  CommandLineLaunch,
  OpenSshProfileMetadata,
  SavedHostProfile,
  SshHostEntry,
  WorkspaceSummary,
} from '@muxus/shared';

/**
 * electron-builder's appId, which the installer stamps on its shortcuts. The
 * windows and the jump list must carry it to belong to that taskbar entry.
 */
export const APP_USER_MODEL_ID = 'io.github.flosch62.muxus';

const RECENT_HOSTS = 5;
const RECENT_WORKSPACES = 3;
/** Windows leaves out an entry with a longer tooltip. */
const DESCRIPTION_MAX_LENGTH = 260;

/** A recently used host or workspace, and the launch that opens it again. */
export interface RecentLaunch {
  title: string;
  launch: Extract<CommandLineLaunch, { kind: 'host' | 'workspace' }>;
}

export interface RecentLaunches {
  hosts: RecentLaunch[];
  workspaces: RecentLaunch[];
}

type HostMetadata = Pick<OpenSshProfileMetadata, 'displayName' | 'lastConnectedAt'>;

function newestFirst(entries: ReadonlyArray<RecentLaunch & { usedAt: string }>): RecentLaunch[] {
  const sorted = entries.toSorted(
    (left, right) => right.usedAt.localeCompare(left.usedAt) || left.title.localeCompare(right.title),
  );
  const unique = new Map<string, RecentLaunch>();
  for (const { title, launch } of sorted) {
    // A host listed in several ssh_config blocks is still one entry.
    if (!unique.has(launch.name)) unique.set(launch.name, { title, launch });
  }
  return [...unique.values()];
}

/**
 * Hosts by their last connection and workspaces by their last opening, or
 * save, newest first. Saved hosts and workspaces are launched by ID, so a
 * rename keeps the entry working; ssh_config hosts by alias, the only name
 * `--host` has for them.
 */
export function recentLaunches(
  sshHosts: ReadonlyArray<Pick<SshHostEntry, 'alias'> & { metadata?: HostMetadata }>,
  savedHosts: ReadonlyArray<Pick<SavedHostProfile, 'id' | 'name'> & { metadata: HostMetadata }>,
  workspaces: ReadonlyArray<Pick<WorkspaceSummary, 'id' | 'name' | 'lastOpenedAt' | 'updatedAt'>>,
): RecentLaunches {
  const hosts = [
    ...sshHosts.map((host) => ({
      usedAt: host.metadata?.lastConnectedAt,
      title: host.metadata?.displayName ?? host.alias,
      launch: { kind: 'host' as const, name: host.alias },
    })),
    ...savedHosts.map((host) => ({
      usedAt: host.metadata.lastConnectedAt,
      title: host.metadata.displayName ?? host.name,
      launch: { kind: 'host' as const, name: host.id },
    })),
  ];
  return {
    hosts: newestFirst(hosts.filter((host): host is typeof host & { usedAt: string } => !!host.usedAt)),
    workspaces: newestFirst(
      workspaces.map((workspace) => ({
        usedAt: workspace.lastOpenedAt ?? workspace.updatedAt,
        title: workspace.name,
        launch: { kind: 'workspace' as const, name: workspace.id },
      })),
    ),
  };
}

/** One argument, quoted so that CommandLineToArgvW reads it back unchanged. */
export function windowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** How a jump list entry starts Muxus: the executable, plus the app folder in a source checkout. */
export interface JumpListLauncher {
  program: string;
  args: readonly string[];
}

/** The entries `app.setJumpList` takes, declared here to keep Electron out of this module. */
export interface JumpListTask {
  type: 'task';
  title: string;
  description: string;
  program: string;
  args: string;
  iconPath: string;
  iconIndex: number;
}

export type JumpListCategory =
  | { type: 'custom'; name: string; items: JumpListTask[] }
  | { type: 'tasks'; items: JumpListTask[] };

/** Recent hosts and workspaces above the New window task. */
export function jumpListCategories(
  recent: RecentLaunches,
  launcher: JumpListLauncher,
  removedArgs: ReadonlySet<string>,
): JumpListCategory[] {
  const task = (title: string, description: string, flag: string): JumpListTask => ({
    type: 'task',
    title,
    description: description.slice(0, DESCRIPTION_MAX_LENGTH),
    program: launcher.program,
    args: [...launcher.args, flag].map(windowsArgument).join(' '),
    iconPath: launcher.program,
    iconIndex: 0,
  });
  const recentTasks = (entries: readonly RecentLaunch[], limit: number, verb: string) =>
    entries
      .map(({ title, launch }) => task(title, `${verb} ${title}`, `--${launch.kind}=${launch.name}`))
      // Entries the user removed stay out until restart; Windows reports a removal once and hides a category that brings it straight back.
      .filter((item) => !removedArgs.has(item.args))
      .slice(0, limit);
  const categories: JumpListCategory[] = [
    { type: 'custom', name: 'Recent hosts', items: recentTasks(recent.hosts, RECENT_HOSTS, 'Connect to') },
    {
      type: 'custom',
      name: 'Recent workspaces',
      items: recentTasks(recent.workspaces, RECENT_WORKSPACES, 'Open workspace'),
    },
    { type: 'tasks', items: [task('New window', 'Open a new Muxus window', '--new-window')] },
  ];
  return categories.filter((category) => category.items.length > 0);
}

export type DockMenuEntry =
  | { label: string; launch: CommandLineLaunch }
  | { label: string; enabled: false }
  | { type: 'separator' };

/** New Window, then the recent hosts and workspaces under a heading each. */
export function dockMenuEntries(recent: RecentLaunches): DockMenuEntry[] {
  const section = (label: string, entries: readonly RecentLaunch[]): DockMenuEntry[] =>
    entries.length === 0
      ? []
      : [
          { type: 'separator' },
          { label, enabled: false },
          ...entries.map((entry) => ({ label: entry.title, launch: entry.launch })),
        ];
  return [
    { label: 'New Window', launch: { kind: 'new-window' } },
    ...section('Recent Hosts', recent.hosts.slice(0, RECENT_HOSTS)),
    ...section('Recent Workspaces', recent.workspaces.slice(0, RECENT_WORKSPACES)),
  ];
}
