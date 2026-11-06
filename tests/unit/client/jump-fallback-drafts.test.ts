import { describe, expect, it } from 'vitest';
import { savedHostHop } from '@muxus/shared';
import { blankDraft, draftProblem, draftToSavedSshInput } from '../../../client/src/components/host-editor/draft.js';
import { savedGatewayFallbacks } from '../../../client/src/components/host-editor/SshGatewayRouteField.js';

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
