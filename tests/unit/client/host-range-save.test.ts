import { describe, expect, it, vi } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import { blankDraft, type HostDraft } from '../../../client/src/components/host-editor/draft.js';
import {
  saveHostRange,
  summarizeRangeSave,
  type RangeSaveSteps,
} from '../../../client/src/components/host-editor/range-save.js';

function drafts(storage: HostDraft['storage'], ...names: string[]): HostDraft[] {
  return names.map((name) => ({ ...blankDraft('', '', storage), aliasText: name, hostname: `${name}.corp` }));
}

const profile = (name: string) => ({ id: `id-${name}`, name }) as SavedHostProfile;

function steps(over: Partial<RangeSaveSteps> = {}): RangeSaveSteps {
  return {
    createConfigHosts: vi.fn(async () => ({ created: 0 })),
    saveProfile: vi.fn(async (input) => profile(input.name)),
    saveSettings: vi.fn(async () => {}),
    ...over,
  };
}

describe('saving a host range', () => {
  it('writes every ssh_config host in one request, then saves each host settings', async () => {
    const s = steps();
    const report = await saveHostRange(drafts('openssh', 'app2', 'app3'), s);

    expect(s.createConfigHosts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.createConfigHosts).mock.calls[0]![0].map((req) => req.aliases)).toEqual([['app2'], ['app3']]);
    expect(s.saveSettings).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ created: ['app2', 'app3'], missingSettings: [] });
    expect(summarizeRangeSave(report)).toEqual({ severity: 'success', message: 'Created 2 hosts.' });
  });

  it('creates nothing when the ssh_config write is refused', async () => {
    const s = steps({ createConfigHosts: vi.fn(async () => Promise.reject(new Error('app3 already exists'))) });
    const report = await saveHostRange(drafts('openssh', 'app2', 'app3'), s);

    expect(s.saveSettings).not.toHaveBeenCalled();
    expect(summarizeRangeSave(report)).toEqual({
      severity: 'error',
      message: 'No hosts were created.',
      detail: 'app3 already exists',
    });
  });

  it('counts a host whose settings failed as created, and names it', async () => {
    const s = steps({
      saveSettings: vi.fn(async (draft: HostDraft) => {
        if (draft.aliasText === 'web3') throw new Error('metadata rejected');
      }),
    });
    const report = await saveHostRange(drafts('muxus', 'web2', 'web3', 'web4'), s);

    expect(report.created).toEqual(['web2', 'web3', 'web4']);
    expect(report.stopped).toBeUndefined();
    expect(summarizeRangeSave(report)).toEqual({
      severity: 'warning',
      message: 'Created 3 hosts. Folder, colour and logging settings were not saved for web3 — edit them to set these.',
      detail: 'metadata rejected',
    });
  });

  it('stops creating Muxus profiles at the first failure and keeps the ones made', async () => {
    const s = steps({
      saveProfile: vi.fn(async (input) => {
        if (input.name === 'web3') throw new Error('name too long');
        return profile(input.name);
      }),
    });
    const report = await saveHostRange(drafts('muxus', 'web2', 'web3', 'web4'), s);

    expect(report.created).toEqual(['web2']);
    expect(report.firstProfile?.id).toBe('id-web2');
    expect(s.saveSettings).toHaveBeenCalledTimes(1);
    expect(summarizeRangeSave(report)).toMatchObject({
      severity: 'warning',
      message: 'Created 1 of 3 hosts, then stopped at web3.',
      detail: 'name too long',
    });
  });

  it('reports progress as it goes', async () => {
    const progress: string[] = [];
    await saveHostRange(drafts('muxus', 'a1', 'a2'), steps(), (message) => progress.push(message));
    expect(progress).toEqual([
      'Creating a1 (1 of 2)…',
      'Creating a2 (2 of 2)…',
      'Saving settings for a1 (1 of 2)…',
      'Saving settings for a2 (2 of 2)…',
    ]);
  });
});
