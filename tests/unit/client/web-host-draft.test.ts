import { describe, expect, it } from 'vitest';
import { savedHostHop, type SavedHostProfile } from '@muxus/shared';
import { blankDraft, draftProblem, draftToSavedSshInput } from '../../../client/src/components/host-editor/draft.js';
import { savedGatewayFallbacks } from '../../../client/src/components/host-editor/SshGatewayRouteField.js';
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

  it('saves the gateway and its fallbacks, dropping blanks and repeats', () => {
    const input = webDraftToInput({
      ...blankWebDraft(),
      name: ' Grafana ',
      url: 'grafana.internal:3000',
      sshGateway: { target: 'bastion-a' },
      sshGatewayFallbacks: [{ target: '' }, { target: 'bastion-b' }, { target: 'bastion-a' }, { target: 'bastion-b' }],
    });
    expect(input).toEqual({
      id: undefined,
      name: 'Grafana',
      profile: {
        kind: 'web',
        url: 'http://grafana.internal:3000',
        sshGateway: { target: 'bastion-a' },
        sshGatewayFallbacks: [{ target: 'bastion-b' }],
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
        sshGateway: { target: 'bastion-a' },
        sshGatewayFallbacks: [{ target: 'bastion-b', profileId: 'p2' }],
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

describe('fallback gateways', () => {
  it('keeps nothing without a first gateway', () => {
    expect(savedGatewayFallbacks(undefined, [{ target: 'b' }])).toBeUndefined();
    expect(savedGatewayFallbacks({ target: 'a' }, [])).toBeUndefined();
  });

  it('tells saved hosts apart by ID, not by their address', () => {
    expect(
      savedGatewayFallbacks({ target: 'h', profileId: 'p1' }, [
        { target: 'h', profileId: 'p2' },
        { target: 'h' },
      ]),
    ).toEqual([{ target: 'h', profileId: 'p2' }, { target: 'h' }]);
  });
});

describe('SSH fallback jump routes', () => {
  const draft = {
    ...blankDraft('', '', 'muxus'),
    aliasText: 'app',
    hostname: 'app.internal',
    routeMode: 'jump' as const,
    proxyJump: ['bastion-a'],
    proxyJumpFallbacks: [['bastion-b'], ['edge', 'bastion-c']],
  };

  it('saves them with a Muxus host on a jump route only', () => {
    expect(draftToSavedSshInput(draft).profile).toMatchObject({
      proxyJump: ['bastion-a'],
      proxyJumpFallbacks: [['bastion-b'], ['edge', 'bastion-c']],
    });
    const direct = draftToSavedSshInput({ ...draft, routeMode: 'direct' }).profile;
    expect(direct).not.toHaveProperty('proxyJumpFallbacks', expect.anything());
  });

  it('needs a first jump host before a fallback', () => {
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem({ ...draft, proxyJump: [] })).toMatch(/jump host before/);
  });

  it('keeps Muxus-saved hosts out of fallbacks for an ssh_config host', () => {
    expect(
      draftProblem({
        ...draft,
        storage: 'openssh',
        proxyJumpFallbacks: [[savedHostHop('abc')]],
      }),
    ).toMatch(/Muxus app data/);
  });
});
