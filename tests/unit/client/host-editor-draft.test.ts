import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import {
  blankDraft,
  draftFromEntry,
  draftToRequest,
  identityAgentForDetection,
} from '../../../client/src/components/host-editor/draft.js';

const entry: SshHostEntry = {
  alias: 'cloud',
  aliases: ['cloud'],
  file: '/home/test/.ssh/config',
  options: {
    hostname: 'cloud.example.test',
    identityFiles: ['~/.ssh/cloud'],
    certificateFiles: ['~/.ssh/cloud-cert.pub'],
    identityAgent: '${ONEPASSWORD_SSH_AUTH_SOCK}',
    proxyCommand: 'cloudflared access ssh --hostname %h',
    remoteCommand: 'tmux new -A -s main',
    requestTty: 'yes',
    strictHostKeyChecking: 'accept-new',
  },
  resolved: {
    hostname: 'cloud.example.test',
    port: 22,
    identityFiles: ['/home/test/.ssh/cloud'],
    certificateFiles: ['/home/test/.ssh/cloud-cert.pub'],
    identitiesOnly: false,
    identityAgent: '${ONEPASSWORD_SSH_AUTH_SOCK}',
    forwardAgent: false,
    proxyJump: [],
    proxyCommand: 'cloudflared access ssh --hostname %h',
    forwards: [],
    passwordOnly: false,
  },
};

describe('SSH host editor draft', () => {
  it('loads and saves modeled connection options as first-class fields', () => {
    const draft = draftFromEntry(entry, false);
    expect(draft.authMode).toBe('key');
    expect(draft.certificateFiles).toEqual(['~/.ssh/cloud-cert.pub']);
    expect(draft.identityAgentMode).toBe('custom');
    expect(draft.identityAgent).toBe('${ONEPASSWORD_SSH_AUTH_SOCK}');
    expect(draft.routeMode).toBe('command');
    expect(draft.proxyCommand).toBe('cloudflared access ssh --hostname %h');
    expect(draft.remoteCommandMode).toBe('command');
    expect(draft.remoteCommand).toBe('tmux new -A -s main');
    expect(draft.requestTty).toBe('yes');
    expect(draft.strictHostKeyChecking).toBe('accept-new');

    expect(draftToRequest(draft, 'cloud').options).toMatchObject({
      identityFiles: ['~/.ssh/cloud'],
      certificateFiles: ['~/.ssh/cloud-cert.pub'],
      identitiesOnly: true,
      identityAgent: '${ONEPASSWORD_SSH_AUTH_SOCK}',
      proxyCommand: 'cloudflared access ssh --hostname %h',
      remoteCommand: 'tmux new -A -s main',
      requestTty: 'yes',
      strictHostKeyChecking: 'accept-new',
    });
  });

  it('starts new hosts with direct routing and no certificates', () => {
    const draft = blankDraft();
    expect(draft.routeMode).toBe('direct');
    expect(draft.certificateFiles).toEqual([]);
    expect(draft.identityAgentMode).toBe('default');
    expect(draft.remoteCommandMode).toBe('inherit');
    expect(draft.requestTty).toBe('inherit');
    expect(draft.strictHostKeyChecking).toBe('inherit');
    expect(draft.identitiesOnly).toBe(true);
    expect(draftToRequest(draft).options.proxyCommand).toBeUndefined();
  });

  it('makes the specific-key promise independent of the SSH agent', () => {
    const draft = blankDraft();
    draft.authMode = 'key';
    draft.identityFiles = ['~/.ssh/id_ed25519'];
    // Old v0.3.0 drafts could carry false here. Saving the explicit editor
    // mode must repair them instead of writing IdentityFile alone.
    draft.identitiesOnly = false;

    expect(draftToRequest(draft).options).toMatchObject({
      identityFiles: ['~/.ssh/id_ed25519'],
      identitiesOnly: true,
    });
  });

  it('round-trips explicit agent and login-shell choices', () => {
    const draft = blankDraft();
    draft.identityAgentMode = 'environment';
    draft.remoteCommandMode = 'shell';
    draft.requestTty = 'auto';
    expect(draftToRequest(draft).options).toMatchObject({
      identityAgent: 'SSH_AUTH_SOCK',
      remoteCommand: 'none',
      requestTty: 'auto',
    });
  });

  it('selects the current per-host agent for live key detection', () => {
    const draft = blankDraft();
    expect(identityAgentForDetection(draft, '${INHERITED_AGENT}')).toBe('${INHERITED_AGENT}');

    draft.identityAgentMode = 'environment';
    expect(identityAgentForDetection(draft, '${INHERITED_AGENT}')).toBe('SSH_AUTH_SOCK');

    draft.identityAgentMode = 'custom';
    draft.identityAgent = '  ~/.1password/agent.sock  ';
    expect(identityAgentForDetection(draft, '${INHERITED_AGENT}')).toBe('~/.1password/agent.sock');

    draft.identityAgent = ' ';
    expect(identityAgentForDetection(draft, '${INHERITED_AGENT}')).toBe('none');

    draft.identityAgentMode = 'none';
    expect(identityAgentForDetection(draft, '${INHERITED_AGENT}')).toBe('none');
  });

  it('splits a prefilled quick-connect target, and leaves a bare name as the alias', () => {
    expect(blankDraft('ops@edge01.lab.test:2222')).toMatchObject({
      aliasText: 'edge01.lab.test',
      hostname: 'edge01.lab.test',
      user: 'ops',
      port: '2222',
    });
    expect(blankDraft('myairframe4')).toMatchObject({
      aliasText: 'myairframe4',
      hostname: '',
      user: '',
      port: '',
    });
  });
});
