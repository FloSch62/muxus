import type { SshHostEntry } from '@muxus/shared';

export const HOST_COLORS = [
  { name: 'Red', value: '#ef5350' },
  { name: 'Orange', value: '#ff9800' },
  { name: 'Amber', value: '#f6c344' },
  { name: 'Green', value: '#4caf72' },
  { name: 'Teal', value: '#26a69a' },
  { name: 'Cyan', value: '#29b6c8' },
  { name: 'Blue', value: '#4285f4' },
  { name: 'Indigo', value: '#6e78e8' },
  { name: 'Purple', value: '#ab68d4' },
  { name: 'Pink', value: '#ec5b91' },
] as const;

export interface HostGroup {
  key: string;
  label: string;
  kind: 'custom' | 'file';
  tooltip?: string;
  hosts: SshHostEntry[];
}

export function hostDisplayName(host: SshHostEntry): string {
  return host.metadata?.displayName ?? host.alias;
}

export function hostAddress(host: SshHostEntry): string {
  const resolved = host.resolved;
  return `${resolved.user ? `${resolved.user}@` : ''}${resolved.hostname}${resolved.port !== 22 ? `:${resolved.port}` : ''}`;
}

export function matchesHost(host: SshHostEntry, needle: string): boolean {
  const normalized = needle.trim().toLowerCase();
  if (!normalized) return true;
  return [
    ...host.aliases,
    host.resolved.hostname,
    host.resolved.user ?? '',
    host.description ?? '',
    host.metadata?.displayName ?? '',
    host.metadata?.group ?? '',
  ].some((value) => value.toLowerCase().includes(normalized));
}

/**
 * Custom Muxus groups take priority. Hosts without one retain the useful
 * config-file grouping, so existing users do not lose structure.
 */
export function groupHosts(
  hosts: readonly SshHostEntry[],
  files: readonly string[],
  rootFile: string | undefined,
  filter = '',
): HostGroup[] {
  const custom = new Map<string, HostGroup>();
  const byFile = new Map<string, SshHostEntry[]>();

  for (const host of hosts) {
    if (!matchesHost(host, filter)) continue;
    const group = host.metadata?.group?.trim();
    if (group) {
      const key = group.toLocaleLowerCase();
      const current = custom.get(key) ?? {
        key: `custom:${key}`,
        label: group,
        kind: 'custom' as const,
        hosts: [],
      };
      current.hosts.push(host);
      custom.set(key, current);
    } else {
      const list = byFile.get(host.file) ?? [];
      list.push(host);
      byFile.set(host.file, list);
    }
  }

  const sortHosts = (list: SshHostEntry[]) =>
    list.sort(
      (a, b) =>
        Number(b.metadata?.favorite ?? false) - Number(a.metadata?.favorite ?? false) ||
        hostDisplayName(a).localeCompare(hostDisplayName(b)),
    );

  const customGroups = [...custom.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((group) => ({ ...group, hosts: sortHosts(group.hosts) }));
  const hasCustomGroups = customGroups.length > 0;
  const fileOrder = new Map(files.map((file, index) => [file, index]));
  const fileGroups = [...byFile.entries()]
    .sort(
      ([a], [b]) =>
        (fileOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (fileOrder.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.localeCompare(b),
    )
    .map(([file, list]): HostGroup => {
      const filename = (file.split(/[\\/]/).pop() ?? file).replace(/\.(conf|config)$/, '');
      const root = file === rootFile;
      return {
        key: `file:${file}`,
        label: hasCustomGroups
          ? root
            ? 'Ungrouped'
            : `Ungrouped · ${filename}`
          : root
            ? 'Hosts'
            : filename,
        kind: 'file',
        tooltip: file,
        hosts: sortHosts(list),
      };
    });

  return [...customGroups, ...fileGroups];
}
