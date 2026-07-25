import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import type { ManagedHost } from '../../../client/src/managed-hosts.js';
import {
  deleteFolderPlan,
  folderProblemMessage,
  folderRewritePlan,
  folderTargetProblem,
  moveHostPlan,
} from '../../../client/src/components/sidebar/folder-mutations.js';

const ROOT = '/home/test/.ssh/config';

function host(alias: string, group?: string): ManagedHost {
  const entry: SshHostEntry = {
    alias,
    aliases: [alias],
    file: ROOT,
    options: {},
    resolved: {
      hostname: `${alias}.example.test`,
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump: [],
      forwards: [],
      passwordOnly: false,
    },
    metadata: { profileId: `ssh-${alias}`, group, connectCount: 0 },
  };
  return { kind: 'ssh', entry };
}

/** Terse view of a plan: alias → resulting group. */
function summary(plan: ReturnType<typeof folderRewritePlan>) {
  return Object.fromEntries(
    plan.map((move) => [
      move.host.kind === 'ssh' ? move.host.entry.alias : move.host.entry.id,
      move.group,
    ]),
  );
}

const HOSTS = [
  host('a', 'Prod'),
  host('b', 'Prod/EU'),
  host('c', 'Prod/EU/Edge'),
  host('d', 'Production'),
  host('e', 'Prodigy/EU'),
  host('f'),
];

describe('folderRewritePlan', () => {
  it('rewrites the folder and every descendant path', () => {
    expect(summary(folderRewritePlan(HOSTS, 'Prod', 'Staging'))).toEqual({
      a: 'Staging',
      b: 'Staging/EU',
      c: 'Staging/EU/Edge',
    });
  });

  it('leaves folders that merely share a string prefix alone', () => {
    const plan = folderRewritePlan(HOSTS, 'Prod', 'Staging');
    const touched = Object.keys(summary(plan));
    expect(touched).not.toContain('d');
    expect(touched).not.toContain('e');
    expect(touched).not.toContain('f');
  });

  it('re-parents a nested folder', () => {
    expect(summary(folderRewritePlan(HOSTS, 'Prod/EU', 'Lab/EU'))).toEqual({
      b: 'Lab/EU',
      c: 'Lab/EU/Edge',
    });
  });

  it('merges into an existing folder when the target already exists', () => {
    expect(summary(folderRewritePlan(HOSTS, 'Prodigy', 'Prod'))).toEqual({ e: 'Prod/EU' });
  });

  it('plans nothing for an unused folder or a no-op rename', () => {
    expect(folderRewritePlan(HOSTS, 'Nowhere', 'Elsewhere')).toEqual([]);
    expect(folderRewritePlan(HOSTS, 'Prod', 'Prod')).toEqual([]);
    expect(folderRewritePlan(HOSTS, 'Prod', ' Prod ')).toEqual([]);
    expect(folderRewritePlan(HOSTS, 'Prod', '  ')).toEqual([]);
  });

  it('rewrites a folder whose name changes only in capitalisation', () => {
    expect(summary(folderRewritePlan(HOSTS, 'Prod', 'prod'))).toEqual({
      a: 'prod',
      b: 'prod/EU',
      c: 'prod/EU/Edge',
    });
  });
});

describe('deleteFolderPlan', () => {
  it('lifts a nested folder one level up', () => {
    expect(summary(deleteFolderPlan(HOSTS, 'Prod/EU'))).toEqual({
      b: 'Prod',
      c: 'Prod/Edge',
    });
  });

  it('clears the group entirely when a top-level folder goes', () => {
    expect(summary(deleteFolderPlan(HOSTS, 'Prod'))).toEqual({
      a: null,
      b: 'EU',
      c: 'EU/Edge',
    });
  });

  it('plans nothing for an empty folder', () => {
    expect(deleteFolderPlan(HOSTS, 'Staging')).toEqual([]);
  });
});

describe('moveHostPlan', () => {
  it('assigns a folder, normalizing the path', () => {
    expect(moveHostPlan(HOSTS[0]!, ' /Lab// EU /').group).toBe('Lab/EU');
  });

  it('clears the folder when the path is empty', () => {
    expect(moveHostPlan(HOSTS[0]!, '   ').group).toBeNull();
  });
});

describe('folderTargetProblem', () => {
  it('accepts an ordinary rename or re-parent', () => {
    expect(folderTargetProblem('Prod', 'Staging')).toBeUndefined();
    expect(folderTargetProblem('Prod', 'Lab/Prod')).toBeUndefined();
  });

  it('rejects an empty target', () => {
    expect(folderTargetProblem('Prod', '  /  ')).toEqual({ kind: 'empty' });
  });

  it('rejects moving a folder inside itself', () => {
    expect(folderTargetProblem('Prod', 'Prod/Sub')).toEqual({ kind: 'into-descendant' });
    // Sharing a prefix is not the same as being a descendant.
    expect(folderTargetProblem('Prod', 'Production')).toBeUndefined();
  });

  it('rejects paths past the depth and length caps', () => {
    expect(folderTargetProblem('', 'a/b/c/d/e/f/g/h/i')).toEqual({ kind: 'too-deep' });
    expect(folderTargetProblem('', 'x'.repeat(301))).toEqual({ kind: 'too-long' });
  });

  it('explains every problem it can report', () => {
    for (const kind of ['empty', 'too-deep', 'too-long', 'into-descendant'] as const) {
      expect(folderProblemMessage({ kind })).toMatch(/\S/);
    }
  });
});
