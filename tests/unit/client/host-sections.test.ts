import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import type { DragSource } from '../../../client/src/components/sidebar/tree-dnd.js';
import {
  canDropOnSection,
  hostSections,
  planSectionDrop,
  sameSectionTarget,
  type HostSection,
} from '../../../client/src/host-sections.js';
import { buildHostTree } from '../../../client/src/host-tree.js';
import { groupManagedHosts } from '../../../client/src/managed-hosts.js';

const ROOT = '/home/test/.ssh/config';

function sshHost(alias: string, group?: string, sortOrder?: number): SshHostEntry {
  return {
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
    metadata: { profileId: `ssh-${alias}`, group, sortOrder, connectCount: 0 },
  };
}

const sections = hostSections(
  buildHostTree(
    groupManagedHosts(
      [
        sshHost('web-01', 'Production/Web', 0),
        sshHost('web-02', 'Production/Web', 1),
        sshHost('web-03', 'Production/Web', 2),
        sshHost('bastion', 'Production'),
        sshHost('loose-a'),
        sshHost('loose-b'),
      ],
      [],
      [ROOT],
      ROOT,
    ),
    { knownFolders: ['Lab'] },
  ),
);
const byLabel = (label: string): HostSection => sections.find((section) => section.label === label)!;
const WEB = 'folder:production/web';
const hosts = (...entries: [alias: string, parentKey: string][]): DragSource => ({
  kind: 'host',
  hosts: entries.map(([alias, parentKey]) => ({ hostKey: `ssh:${alias}`, parentKey })),
});

describe('the sections of the hosts tab', () => {
  it('lists every folder depth-first, then the file groups, with only their own hosts', () => {
    expect(sections.map((section) => [section.label, section.hosts.length])).toEqual([
      ['Lab', 0],
      ['Production', 1],
      ['Production / Web', 3],
      ['Ungrouped', 2],
    ]);
    expect(byLabel('Production / Web')).toMatchObject({ kind: 'folder', path: 'Production/Web', depth: 1 });
    expect(byLabel('Ungrouped').kind).toBe('file');
    expect(byLabel('Ungrouped').path).toBeUndefined();
  });
});

describe('what a section takes', () => {
  it('lets any host be filed in a folder', () => {
    expect(canDropOnSection(hosts(['loose-a', byLabel('Ungrouped').key]), byLabel('Lab'))).toBe(true);
  });

  it('gives an ssh_config file group only its own hosts back', () => {
    const ungrouped = byLabel('Ungrouped');
    expect(canDropOnSection(hosts(['loose-a', ungrouped.key]), ungrouped)).toBe(true);
    expect(canDropOnSection(hosts(['web-01', WEB]), ungrouped)).toBe(false);
  });

  it('takes no folders', () => {
    expect(
      canDropOnSection({ kind: 'folder', folderKey: 'folder:lab', path: 'Lab' }, byLabel('Production')),
    ).toBe(false);
  });
});

describe('planning a drop', () => {
  const web = byLabel('Production / Web');

  it('reorders within a folder without touching the folder', () => {
    const plan = planSectionDrop(hosts(['web-03', WEB]), web, { sectionKey: WEB, beforeKey: 'ssh:web-01' });
    expect(plan).toEqual({
      hostKeys: ['ssh:web-03'],
      path: undefined,
      order: ['ssh:web-03', 'ssh:web-01', 'ssh:web-02'],
    });
  });

  it('writes nothing when a host is let go where it already is', () => {
    expect(planSectionDrop(hosts(['web-02', WEB]), web, { sectionKey: WEB, beforeKey: 'ssh:web-03' })).toBeUndefined();
    expect(planSectionDrop(hosts(['web-02', WEB]), web, { sectionKey: WEB, beforeKey: 'ssh:web-02' })).toBeUndefined();
    expect(planSectionDrop(hosts(['web-03', WEB]), web, { sectionKey: WEB })).toBeUndefined();
  });

  it('files hosts from elsewhere in the folder, at the spot they were dropped', () => {
    const plan = planSectionDrop(hosts(['bastion', 'folder:production']), web, {
      sectionKey: WEB,
      beforeKey: 'ssh:web-02',
    });
    expect(plan).toEqual({
      hostKeys: ['ssh:bastion'],
      path: 'Production/Web',
      order: ['ssh:web-01', 'ssh:bastion', 'ssh:web-02', 'ssh:web-03'],
    });
  });

  it('appends at the end of a folder when no host is named', () => {
    const lab = byLabel('Lab');
    expect(planSectionDrop(hosts(['web-01', WEB], ['bastion', 'folder:production']), lab, { sectionKey: lab.key })).toEqual({
      hostKeys: ['ssh:web-01', 'ssh:bastion'],
      path: 'Lab',
      order: ['ssh:web-01', 'ssh:bastion'],
    });
  });

  it('keeps a selection together and lands it before the next host that stays', () => {
    const plan = planSectionDrop(hosts(['web-01', WEB], ['web-02', WEB]), web, { sectionKey: WEB });
    expect(plan?.order).toEqual(['ssh:web-03', 'ssh:web-01', 'ssh:web-02']);
    // Dropped on one of its own: the line is drawn before the next host not being dragged.
    expect(
      planSectionDrop(hosts(['web-01', WEB], ['web-03', WEB]), web, { sectionKey: WEB, beforeKey: 'ssh:web-01' }),
    ).toMatchObject({ order: ['ssh:web-01', 'ssh:web-03', 'ssh:web-02'] });
  });

  it('refuses what the section does not take', () => {
    expect(planSectionDrop(hosts(['web-01', WEB]), byLabel('Ungrouped'), { sectionKey: byLabel('Ungrouped').key })).toBeUndefined();
  });
});

describe('telling two drop targets apart', () => {
  it('compares the section and the host the drop lands before', () => {
    expect(sameSectionTarget(null, null)).toBe(true);
    expect(sameSectionTarget({ sectionKey: WEB }, null)).toBe(false);
    expect(sameSectionTarget({ sectionKey: WEB, beforeKey: 'a' }, { sectionKey: WEB, beforeKey: 'a' })).toBe(true);
    expect(sameSectionTarget({ sectionKey: WEB, beforeKey: 'a' }, { sectionKey: WEB })).toBe(false);
  });
});
