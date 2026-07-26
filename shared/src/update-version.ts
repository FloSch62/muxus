interface ParsedVersion {
  core: [string, string, string];
  prerelease: string[];
}

const SEMVER =
  /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version.trim());
  if (!match) return undefined;

  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    return undefined;
  }

  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  };
}

function compareNumeric(candidate: string, current: string): number {
  if (candidate.length !== current.length) return candidate.length > current.length ? 1 : -1;
  if (candidate === current) return 0;
  return candidate > current ? 1 : -1;
}

function comparePrerelease(candidate: string[], current: string[]): number {
  if (candidate.length === 0 || current.length === 0) {
    if (candidate.length === current.length) return 0;
    return candidate.length === 0 ? 1 : -1;
  }

  const length = Math.max(candidate.length, current.length);
  for (let index = 0; index < length; index++) {
    const next = candidate[index];
    const installed = current[index];
    if (next === undefined || installed === undefined) {
      if (next === installed) return 0;
      return next === undefined ? -1 : 1;
    }
    if (next === installed) continue;

    const nextNumeric = /^\d+$/.test(next);
    const installedNumeric = /^\d+$/.test(installed);
    if (nextNumeric && installedNumeric) return compareNumeric(next, installed);
    if (nextNumeric !== installedNumeric) return nextNumeric ? -1 : 1;
    return next > installed ? 1 : -1;
  }
  return 0;
}

/** True when candidate has higher SemVer precedence than current. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let index = 0; index < next.core.length; index++) {
    const nextPart = next.core[index]!;
    const installedPart = installed.core[index]!;
    const precedence = compareNumeric(nextPart, installedPart);
    if (precedence !== 0) return precedence > 0;
  }

  return comparePrerelease(next.prerelease, installed.prerelease) > 0;
}
