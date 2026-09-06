import type { AppWindowLaunch } from '@muxus/shared';
export function parseWindowLaunch(value: unknown): AppWindowLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const launch = value as Record<string, unknown>;
  if (launch.kind === 'workspace') {
    if (
      typeof launch.title !== 'string' ||
      launch.title.length === 0 ||
      launch.title.length > 200 ||
      (launch.workspaceId !== undefined &&
        (typeof launch.workspaceId !== 'string' ||
          launch.workspaceId.length === 0 ||
          launch.workspaceId.length > 200))
    ) {
      return undefined;
    }
    return value as AppWindowLaunch;
  }
  if (launch.kind === 'session') {
    if (
      typeof launch.title !== 'string' ||
      launch.title.length > 500 ||
      !launch.profile ||
      typeof launch.profile !== 'object'
    ) {
      return undefined;
    }
    const profile = launch.profile as Record<string, unknown>;
    const valid =
      (profile.kind === 'local' &&
        (profile.shell === undefined || typeof profile.shell === 'string') &&
        (profile.cwd === undefined || typeof profile.cwd === 'string')) ||
      (profile.kind === 'ssh' &&
        typeof profile.target === 'string' &&
        profile.target.length > 0 &&
        profile.target.length <= 500) ||
      (profile.kind === 'telnet' &&
        validProfileId(profile.profileId) &&
        typeof profile.host === 'string' &&
        profile.host.length > 0 &&
        profile.host.length <= 253 &&
        (profile.port === undefined ||
          (typeof profile.port === 'number' &&
            Number.isInteger(profile.port) &&
            profile.port >= 1 &&
            profile.port <= 65_535))) ||
      (profile.kind === 'serial' &&
        validProfileId(profile.profileId) &&
        typeof profile.path === 'string' &&
        profile.path.length > 0 &&
        profile.path.length <= 4096 &&
        (profile.baudRate === undefined ||
          (typeof profile.baudRate === 'number' &&
            Number.isInteger(profile.baudRate) &&
            profile.baudRate >= 1 &&
            profile.baudRate <= 12_000_000)) &&
        (profile.dataBits === undefined || [5, 6, 7, 8].includes(profile.dataBits as number)) &&
        (profile.stopBits === undefined || [1, 1.5, 2].includes(profile.stopBits as number)) &&
        (profile.parity === undefined ||
          ['none', 'even', 'odd', 'mark', 'space'].includes(profile.parity as string)) &&
        (profile.flowControl === undefined ||
          ['none', 'hardware', 'software'].includes(profile.flowControl as string)));
    if (!valid) return undefined;
    return value as AppWindowLaunch;
  }
  if (launch.kind === 'tab-transfer') {
    if (
      typeof launch.transferId !== 'string' ||
      launch.transferId.length === 0 ||
      launch.transferId.length > 200 ||
      typeof launch.title !== 'string' ||
      launch.title.length > 500
    ) {
      return undefined;
    }
    return value as AppWindowLaunch;
  }
  if (
    launch.kind !== 'sftp' ||
    typeof launch.connId !== 'string' ||
    launch.connId.length === 0 ||
    launch.connId.length > 200 ||
    typeof launch.title !== 'string' ||
    launch.title.length > 500 ||
    (launch.path !== undefined && (typeof launch.path !== 'string' || launch.path.length > 4096))
  ) {
    return undefined;
  }
  return value as AppWindowLaunch;
}

function validProfileId(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length >= 1 && value.length <= 200)
  );
}
