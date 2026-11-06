import { describe, expect, it } from 'vitest';
import {
  blankShareDraft,
  parseShareAddress,
  shareDraftProblem,
  shareDraftToInput,
} from '../../../client/src/components/host-editor/share-draft.js';

describe('share addresses', () => {
  it('reads UNC paths and smb:// URLs', () => {
    expect(parseShareAddress('\\\\fs01\\Public\\Reports\\2026')).toEqual({
      host: 'fs01',
      share: 'Public',
      folder: 'Reports/2026',
    });
    expect(parseShareAddress('smb://alice@fs01:4450/Team%20Docs')).toEqual({
      username: 'alice',
      host: 'fs01',
      port: '4450',
      share: 'Team Docs',
    });
  });

  it('reads NFS exports', () => {
    expect(parseShareAddress('nas.lab:/srv/data')).toEqual({ host: 'nas.lab', exportPath: '/srv/data' });
    expect(parseShareAddress('nfs://nas.lab/srv/data')).toEqual({ host: 'nas.lab', exportPath: '/srv/data' });
    expect(parseShareAddress('nas.lab')).toEqual({ host: 'nas.lab' });
  });
});

describe('share drafts', () => {
  it('saves an SMB share with its folder and user', () => {
    const draft = { ...blankShareDraft('\\\\fs01\\Public\\Reports\\'), name: 'Reports', username: 'CORP\\alice' };
    expect(shareDraftProblem(draft, 'smb')).toBeNull();
    expect(shareDraftToInput(draft, 'smb').profile).toEqual({
      kind: 'smb',
      host: 'fs01',
      port: 445,
      share: 'Public',
      folder: 'Reports',
      username: 'CORP\\alice',
    });
  });

  it('saves an NFS export', () => {
    const draft = { ...blankShareDraft('nas:/srv/data'), name: 'Data', readOnly: true };
    expect(shareDraftToInput(draft, 'nfs').profile).toEqual({
      kind: 'nfs',
      host: 'nas',
      export: '/srv/data',
      readOnly: true,
    });
  });

  it('catches what cannot be mounted', () => {
    const smb = { ...blankShareDraft('fs01'), name: 'x' };
    expect(shareDraftProblem(smb, 'smb')).toMatch(/share name/);
    expect(shareDraftProblem({ ...smb, share: 'a/b' }, 'smb')).toMatch(/Folder/);
    const nfs = { ...blankShareDraft('nas'), name: 'x', exportPath: 'srv' };
    expect(shareDraftProblem(nfs, 'nfs')).toMatch(/starts with \//);
    expect(
      shareDraftProblem({ ...nfs, exportPath: '/srv', version: '3', sshGateway: { target: 'bastion' } }, 'nfs'),
    ).toMatch(/NFSv4/);
  });
});
