import { describe, expect, it } from 'vitest';
import type { SshHostEntry } from '@muxus/shared';
import {
  blankDraft,
  draftFromEntry,
  draftToRequest,
} from '../../../client/src/components/host-editor/draft.js';

const entry: SshHostEntry = {
  alias: 'cloud',
  aliases: ['cloud'],
  file: '/home/test/.ssh/config',
  options: {
    hostname: 'cloud.example.test',
    identityFiles: ['~/.ssh/cloud'],
    certificateFiles: ['~/.ssh/cloud-cert.pub'],
    proxyCommand: 'cloudflared access ssh --hostname %h',
  },
  resolved: {
    hostname: 'cloud.example.test',
    port: 22,
    identityFiles: ['/home/test/.ssh/cloud'],
    certificateFiles: ['/home/test/.ssh/cloud-cert.pub'],
    identitiesOnly: false,
    forwardAgent: false,
    proxyJump: [],
    proxyCommand: 'cloudflared access ssh --hostname %h',
    forwards: [],
    passwordOnly: false,
  },
};

describe('SSH host editor draft', () => {
  it('loads and saves CertificateFile and ProxyCommand as first-class fields', () => {
    const draft = draftFromEntry(entry, false);
    expect(draft.authMode).toBe('key');
    expect(draft.certificateFiles).toEqual(['~/.ssh/cloud-cert.pub']);
    expect(draft.routeMode).toBe('command');
    expect(draft.proxyCommand).toBe('cloudflared access ssh --hostname %h');

    expect(draftToRequest(draft, 'cloud').options).toMatchObject({
      identityFiles: ['~/.ssh/cloud'],
      certificateFiles: ['~/.ssh/cloud-cert.pub'],
      proxyCommand: 'cloudflared access ssh --hostname %h',
    });
  });

  it('starts new hosts with direct routing and no certificates', () => {
    const draft = blankDraft();
    expect(draft.routeMode).toBe('direct');
    expect(draft.certificateFiles).toEqual([]);
    expect(draftToRequest(draft).options.proxyCommand).toBeUndefined();
  });
});
