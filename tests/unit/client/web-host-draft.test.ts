import { describe, expect, it } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import {
  blankWebDraft,
  normalizeWebUrl,
  webDraftFromProfile,
  webDraftProblem,
  webDraftToInput,
} from '../../../client/src/components/host-editor/web-draft.js';

describe('web host drafts', () => {
  it('adds http:// to an address without a scheme', () => {
    expect(normalizeWebUrl('grafana.internal:3000/d/x')).toBe('http://grafana.internal:3000/d/x');
    expect(normalizeWebUrl('https://ilo.lab')).toBe('https://ilo.lab');
    expect(normalizeWebUrl('  ')).toBe('');
  });

  it('needs a name and an http(s) address', () => {
    const draft = { ...blankWebDraft(), name: 'Grafana', url: 'grafana.internal' };
    expect(webDraftProblem(draft)).toBeNull();
    expect(webDraftProblem({ ...draft, name: ' ' })).toMatch(/name/);
    expect(webDraftProblem({ ...draft, url: '' })).toMatch(/address/);
    expect(webDraftProblem({ ...draft, url: 'ftp://files.lab' })).toMatch(/http/);
  });

  it('saves the gateway with a normalized address', () => {
    const input = webDraftToInput({
      ...blankWebDraft(),
      name: ' Grafana ',
      url: 'grafana.internal:3000',
      sshGateway: { target: 'bastion-a' },
    });
    expect(input).toEqual({
      id: undefined,
      name: 'Grafana',
      profile: {
        kind: 'web',
        url: 'http://grafana.internal:3000',
        sshGateway: { target: 'bastion-a' },
      },
    });
  });

  it('round-trips a saved page', () => {
    const saved = {
      id: 'w1',
      kind: 'web',
      name: 'Grafana',
      profile: {
        kind: 'web',
        url: 'https://grafana.internal',
        sshGateway: { target: 'bastion-a', profileId: 'p2' },
      },
      metadata: { group: 'Monitoring', connectCount: 0 },
      createdAt: '',
      updatedAt: '',
    } as SavedHostProfile;
    const draft = webDraftFromProfile(saved, true);
    expect(draft).toMatchObject({ name: 'Grafana copy', group: 'Monitoring' });
    expect(webDraftToInput(draft, 'w1').profile).toEqual(saved.profile);
  });
});

