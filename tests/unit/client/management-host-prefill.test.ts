import { describe, expect, it } from 'vitest';
import { savedHostHop, type SavedHostProfile, type SshHostEntry } from '@muxus/shared';
import { managementHostPrefill } from '../../../client/src/components/host-editor/management-draft.js';

function sshEntry(proxyJump: string[]): SshHostEntry {
  return {
    alias: 'leaf1',
    aliases: ['leaf1'],
    file: '/home/test/.ssh/config',
    options: { hostname: '10.0.0.11', user: 'admin', proxyJump },
    resolved: {
      hostname: '10.0.0.11',
      user: 'admin',
      port: 22,
      identityFiles: [],
      certificateFiles: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyJump,
      forwards: [],
      passwordOnly: false,
    },
    metadata: { profileId: 'leaf1', group: 'Lab', connectCount: 0 },
  };
}

function savedSsh(id: string, target: string, proxyJump?: string[]): SavedHostProfile {
  return {
    id,
    kind: 'ssh',
    name: id,
    profile: { kind: 'ssh', profileId: id, target, useConfig: false, user: 'admin', ...(proxyJump ? { proxyJump } : {}) },
    metadata: { profileId: id, group: 'Lab', connectCount: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const bastion = savedSsh('bastion', 'bastion.example.test');

describe('management host prefill', () => {
  it('carries an ssh_config jump host over to gNMI as its gateway', () => {
    expect(managementHostPrefill({ kind: 'ssh', entry: sshEntry(['jump']) }, 'gnmi', [])).toEqual({
      mode: 'new',
      kind: 'gnmi',
      prefillTarget: 'admin@10.0.0.11',
      prefillName: 'leaf1 (gNMI)',
      prefillGateway: { target: 'jump' },
      group: 'Lab',
    });
  });

  it('leaves NETCONF on the ssh_config alias, which already routes through the jump host', () => {
    const prefill = managementHostPrefill({ kind: 'ssh', entry: sshEntry(['jump']) }, 'netconf', []);
    expect(prefill.prefillTarget).toBe('admin@leaf1');
    expect(prefill.prefillGateway).toBeUndefined();
  });

  it('uses the last hop of a chain and resolves saved Muxus hosts', () => {
    const entry = sshEntry(['outer', savedHostHop('bastion')]);
    expect(managementHostPrefill({ kind: 'ssh', entry }, 'gnmi', [bastion]).prefillGateway).toEqual({
      target: 'bastion.example.test',
      profileId: 'bastion',
    });
  });

  it('carries a saved SSH host jump over to gNMI and NETCONF', () => {
    const leaf = savedSsh('leaf1', 'admin@10.0.0.11:2222', [savedHostHop('bastion')]);
    for (const kind of ['gnmi', 'netconf'] as const) {
      const prefill = managementHostPrefill({ kind: 'profile', entry: leaf }, kind, [bastion, leaf]);
      expect(prefill).toMatchObject({
        prefillTarget: 'admin@10.0.0.11',
        prefillGateway: { target: 'bastion.example.test', profileId: 'bastion' },
        group: 'Lab',
      });
    }
  });

  it('connects directly without a jump host, or when the saved jump host is gone', () => {
    expect(managementHostPrefill({ kind: 'ssh', entry: sshEntry([]) }, 'gnmi', []).prefillGateway).toBeUndefined();
    expect(managementHostPrefill({ kind: 'ssh', entry: sshEntry(['none']) }, 'gnmi', []).prefillGateway).toBeUndefined();
    const orphan = savedSsh('leaf1', '10.0.0.11', [savedHostHop('deleted')]);
    expect(managementHostPrefill({ kind: 'profile', entry: orphan }, 'gnmi', []).prefillGateway).toBeUndefined();
  });
});
