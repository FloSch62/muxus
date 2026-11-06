import { describe, expect, it } from 'vitest';
import { blankDraft, type HostDraft } from '../../../client/src/components/host-editor/draft.js';
import {
  describeDraftRange,
  expandDraftRange,
  parseNameRange,
  rangeExample,
} from '../../../client/src/components/host-editor/name-range.js';

function draft(aliasText: string, hostname: string, storage: HostDraft['storage'] = 'openssh'): HostDraft {
  return { ...blankDraft('', '', storage), aliasText, hostname, user: 'ops', port: '2222' };
}

const names = (drafts: HostDraft[]) => drafts.map((d) => d.aliasText);
const hostnames = (drafts: HostDraft[]) => drafts.map((d) => d.hostname);

describe('host name ranges', () => {
  it('leaves names without a range alone', () => {
    expect(parseNameRange('grvdgmapp1')).toBeUndefined();
    expect(expandDraftRange(draft('grvdgmapp1-copy', 'x'), 'grvdgmapp1')).toBeUndefined();
  });

  it('expands grvdgmapp[2-10] and follows the duplicated name in the HostName', () => {
    const result = expandDraftRange(draft('grvdgmapp[2-10]', 'grvdgmapp1.corp.local'), 'grvdgmapp1');
    expect(result?.problem).toBeNull();
    expect(names(result!.drafts)).toEqual([
      'grvdgmapp2', 'grvdgmapp3', 'grvdgmapp4', 'grvdgmapp5', 'grvdgmapp6',
      'grvdgmapp7', 'grvdgmapp8', 'grvdgmapp9', 'grvdgmapp10',
    ]);
    expect(hostnames(result!.drafts)[0]).toBe('grvdgmapp2.corp.local');
    expect(hostnames(result!.drafts)[8]).toBe('grvdgmapp10.corp.local');
    // Everything else is copied from the source.
    expect(result!.drafts.every((d) => d.user === 'ops' && d.port === '2222')).toBe(true);
  });

  it('accepts .. and : separators and keeps zero padding', () => {
    expect(names(expandDraftRange(draft('db[08..10]', ''), undefined)!.drafts)).toEqual(['db08', 'db09', 'db10']);
    expect(names(expandDraftRange(draft('db[1:3]-eu', ''), undefined)!.drafts)).toEqual(['db1-eu', 'db2-eu', 'db3-eu']);
  });

  it('only replaces the source name as a whole word', () => {
    const result = expandDraftRange(draft('app[2-3]', 'app10.corp'), 'app1');
    expect(hostnames(result!.drafts)).toEqual(['app10.corp', 'app10.corp']);
  });

  it('matches the source name in the HostName case-insensitively', () => {
    const result = expandDraftRange(draft('APP[2-3]', 'app1.corp'), 'APP1');
    expect(hostnames(result!.drafts)).toEqual(['APP2.corp', 'APP3.corp']);
  });

  it('expands a HostName range in step with the name', () => {
    const result = expandDraftRange(draft('web[2-4]', '10.0.0.[12-14]'), 'web1');
    expect(hostnames(result!.drafts)).toEqual(['10.0.0.12', '10.0.0.13', '10.0.0.14']);
    expect(expandDraftRange(draft('web[2-4]', '10.0.0.[12-20]'), 'web1')?.problem).toMatch(/9 values/);
  });

  it('copies an unrelated HostName and an empty one unchanged', () => {
    expect(hostnames(expandDraftRange(draft('web[2-3]', '10.0.0.1'), 'web1')!.drafts)).toEqual(['10.0.0.1', '10.0.0.1']);
    expect(hostnames(expandDraftRange(draft('web[2-3]', ''), 'web1')!.drafts)).toEqual(['', '']);
  });

  it('reports ranges that cannot be saved', () => {
    expect(expandDraftRange(draft('web[5-2]', ''), undefined)?.problem).toMatch(/count up/);
    expect(expandDraftRange(draft('web[1-1000]', ''), undefined)?.problem).toMatch(/at most/);
    expect(expandDraftRange(draft('r[1-2]c[1-2]', ''), undefined)?.problem).toMatch(/one \[from-to\]/);
    expect(expandDraftRange(draft('web[1-2] other', ''), undefined)?.problem).toMatch(/single alias/);
    expect(
      expandDraftRange(draft('web[1-3]', ''), undefined, new Set(['web2']))?.problem,
    ).toMatch(/"web2" already exists/);
  });

  it('allows spaces in Muxus profile names', () => {
    const result = expandDraftRange(draft('edge router [1-2]', 'r1', 'muxus'), undefined);
    expect(names(result!.drafts)).toEqual(['edge router 1', 'edge router 2']);
  });

  it('suggests a range from the duplicated name', () => {
    expect(rangeExample('grvdgmapp1')).toBe('grvdgmapp[2-10]');
    expect(rangeExample('bastion')).toBe('bastion[1-10]');
  });

  it('describes what a save will create', () => {
    const result = expandDraftRange(draft('grvdgmapp[2-10]', 'grvdgmapp1.corp'), 'grvdgmapp1')!;
    expect(describeDraftRange(result.drafts)).toBe(
      'Creates 9 hosts: grvdgmapp2 … grvdgmapp10 — HostName grvdgmapp2.corp … grvdgmapp10.corp',
    );
    const same = expandDraftRange(draft('web[2-3]', '10.0.0.1'), 'web1')!;
    expect(describeDraftRange(same.drafts)).toMatch(/all connect to 10\.0\.0\.1/);
  });
});
