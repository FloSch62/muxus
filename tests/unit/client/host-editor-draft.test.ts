import { describe, expect, it } from 'vitest';
import { savedHostHop, type SavedHostProfile, type SshHostEntry } from '@muxus/shared';
import {
  authChoice,
  blankDraft,
  draftFromEntry,
  draftFromSavedSshProfile,
  draftProblem,
  draftToRequest,
  draftToSavedSshInput,
  identityAgentForDetection,
  keyFilesCaption,
  keyModeHelp,
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
  it('loads and saves a self-contained Muxus SSH profile', () => {
    const saved: SavedHostProfile = {
      id: 'muxus-router',
      kind: 'ssh',
      name: 'Core router',
      profile: {
        kind: 'ssh',
        profileId: 'muxus-router',
        target: 'router.example.test',
        useConfig: false,
        user: 'admin',
        port: 2222,
        identityFiles: ['~/.ssh/router'],
        identitiesOnly: true,
        proxyJump: ['bastion'],
      },
      metadata: {
        profileId: 'muxus-router',
        group: 'Production',
        terminalScheme: 'nord',
        terminalFontColor: '#f8f8f2',
        terminalBackgroundColor: '#282a36',
        connectCount: 0,
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const draft = draftFromSavedSshProfile(saved, false);
    expect(draft).toMatchObject({
      storage: 'muxus',
      aliasText: 'Core router',
      hostname: 'router.example.test',
      user: 'admin',
      port: '2222',
      group: 'Production',
      terminalScheme: 'nord',
      terminalFontColor: '#f8f8f2',
      terminalBackgroundColor: '#282a36',
      authMode: 'key',
      routeMode: 'jump',
    });
    expect(draftProblem(draft)).toBeNull();
    expect(draftToSavedSshInput(draft, saved.id)).toMatchObject({
      id: 'muxus-router',
      name: 'Core router',
      profile: {
        kind: 'ssh',
        target: 'router.example.test',
        useConfig: false,
        user: 'admin',
        port: 2222,
        identityFiles: ['~/.ssh/router'],
        identitiesOnly: true,
        proxyJump: ['bastion'],
      },
    });
  });

  it('keeps saved Muxus jump hosts out of ssh_config storage', () => {
    const draft = {
      ...blankDraft(),
      aliasText: 'router',
      hostname: 'router.example.test',
      routeMode: 'jump' as const,
      proxyJump: [savedHostHop('muxus-bastion')],
    };

    expect(draftProblem({ ...draft, storage: 'muxus' })).toBeNull();
    expect(draftProblem({ ...draft, storage: 'openssh' })).toMatch(
      /Muxus app data storage/,
    );
  });

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
      identitiesOnly: undefined,
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
    expect(draft.disableSftp).toBe(false);
    expect(draft.consoleCompatibility).toBe(false);
    expect(draft.terminalScheme).toBeUndefined();
    expect(draft.terminalFontColor).toBeUndefined();
    expect(draft.terminalBackgroundColor).toBeUndefined();
    expect(draftToRequest(draft).options.proxyCommand).toBeUndefined();
  });

  it('loads the Muxus-only SFTP compatibility setting', () => {
    const draft = draftFromEntry(
      {
        ...entry,
        metadata: {
          profileId: 'profile-cloud',
          connectCount: 0,
          disableSftp: true,
          consoleCompatibility: true,
          terminalScheme: 'solarized-dark',
          terminalFontColor: '#eeeeee',
          terminalBackgroundColor: '#101820',
        },
      },
      false,
    );

    expect(draft.disableSftp).toBe(true);
    expect(draft.consoleCompatibility).toBe(true);
    expect(draft.terminalScheme).toBe('solarized-dark');
    expect(draft.terminalFontColor).toBe('#eeeeee');
    expect(draft.terminalBackgroundColor).toBe('#101820');
    expect(draftToRequest(draft).options).not.toHaveProperty('disableSftp');
    expect(draftToRequest(draft).options).not.toHaveProperty('consoleCompatibility');
  });

  it('makes the specific-key promise independent of the SSH agent', () => {
    const created = {
      ...blankDraft(),
      ...authChoice({ authMode: 'key' }),
      ...authChoice({ identityFiles: ['~/.ssh/id_ed25519'] }),
    };
    expect(draftToRequest(created).options).toMatchObject({
      identityFiles: ['~/.ssh/id_ed25519'],
      identitiesOnly: true,
    });
    const savedProfile = draftToSavedSshInput({ ...created, storage: 'muxus' }).profile;
    if (savedProfile.kind !== 'ssh') throw new Error('Expected an SSH profile');
    expect(savedProfile.identitiesOnly).toBe(true);

    // Hosts saved by v0.3.0 list IdentityFile alone. Choosing their keys
    // again makes the promise, so the save repairs them.
    const loaded = draftFromEntry(entry, false);
    for (const choice of [
      authChoice({ identityFiles: [...loaded.identityFiles, '~/.ssh/backup'] }),
      authChoice({ certificateFiles: [] }),
    ]) {
      expect(draftToRequest({ ...loaded, ...choice }, 'cloud').options.identitiesOnly).toBe(true);
    }

    const agentOnly = draftFromEntry(
      { ...entry, options: { hostname: 'cloud.example.test', identitiesOnly: false } },
      false,
    );
    expect(agentOnly.authMode).toBe('default');
    const switched = {
      ...agentOnly,
      ...authChoice({ authMode: 'key' }),
      ...authChoice({ identityFiles: ['~/.ssh/cloud'] }),
    };
    expect(draftToRequest(switched, 'cloud').options.identitiesOnly).toBe(true);
  });

  it('keeps IdentitiesOnly as the config has it when other fields change', () => {
    // A hand-written IdentityFile without IdentitiesOnly still offers agent
    // keys; saving an unrelated field must not take them away.
    const draft = { ...draftFromEntry(entry, false), terminalScheme: 'nord' };
    expect(draft.authMode).toBe('key');
    expect(draftToRequest(draft, 'cloud').options.identitiesOnly).toBeUndefined();
    expect(draftToRequest(draftFromEntry(entry, true)).options.identitiesOnly).toBeUndefined();

    const explicitNo = draftFromEntry(
      { ...entry, options: { ...entry.options, identitiesOnly: false } },
      false,
    );
    expect(
      draftToRequest({ ...explicitNo, user: 'ops' }, 'cloud').options.identitiesOnly,
    ).toBe(false);
  });

  it('keeps IdentitiesOnly as a saved Muxus host has it when other fields change', () => {
    const saved = (identitiesOnly?: boolean): SavedHostProfile => ({
      id: 'imported-router',
      kind: 'ssh',
      name: 'Imported router',
      profile: {
        kind: 'ssh',
        profileId: 'imported-router',
        target: 'router.example.test',
        useConfig: false,
        identityFiles: ['~/.ssh/router'],
        identitiesOnly,
      },
      metadata: { profileId: 'imported-router', connectCount: 0 },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    for (const identitiesOnly of [undefined, false]) {
      const draft = {
        ...draftFromSavedSshProfile(saved(identitiesOnly), false),
        terminalBackgroundColor: '#101820',
      };
      const profile = draftToSavedSshInput(draft, 'imported-router').profile;
      if (profile.kind !== 'ssh') throw new Error('Expected an SSH profile');
      expect(profile.identityFiles).toEqual(['~/.ssh/router']);
      expect(profile.identitiesOnly).toBe(identitiesOnly);
    }
  });

  it('promises exactly these keys only where the draft sets IdentitiesOnly yes', () => {
    // IdentityFile alone, as listed or as kept with IdentitiesOnly no.
    const loaded = draftFromEntry(entry, false);
    const explicitNo = draftFromEntry(
      { ...entry, options: { ...entry.options, identitiesOnly: false } },
      false,
    );
    for (const draft of [loaded, explicitNo, { ...loaded, storage: 'muxus' as const }]) {
      expect(keyModeHelp(draft)).not.toMatch(/exactly/i);
      // Host *, folder credentials or the agent source may still turn agent keys off.
      expect(keyFilesCaption(draft)).toBe(
        'IdentitiesOnly yes is not set here, so keys in the SSH agent are offered too unless another setting turns that off. Changing the key or certificate files sets it.',
      );
    }
    expect(keyModeHelp(loaded)).toBe('Writes IdentityFile');

    // Choosing keys, or the mode from another one, makes the promise.
    const chosen = { ...loaded, ...authChoice({ identityFiles: ['~/.ssh/cloud'] }) };
    expect(keyModeHelp(chosen)).toBe('Writes IdentityFile — exactly these keys are offered');
    expect(keyFilesCaption(chosen)).toMatch(/^Only these key files are offered/);
    const agentOnly = draftFromEntry(
      { ...entry, options: { hostname: 'cloud.example.test', identitiesOnly: false } },
      false,
    );
    expect(keyModeHelp(agentOnly)).toBe('Writes IdentityFile — exactly these keys are offered');
    expect(keyModeHelp({ ...blankDraft(), storage: 'muxus' })).toBe(
      'Exactly these keys are offered for this Muxus connection',
    );
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
    const savedProfile = draftToSavedSshInput(draft).profile;
    expect(savedProfile.kind).toBe('ssh');
    if (savedProfile.kind !== 'ssh') throw new Error('Expected an SSH profile');
    expect(savedProfile.remoteCommand).toBeUndefined();
  });

  it('writes ForwardX11 only when the host overrides the default', () => {
    const draft = blankDraft();
    expect(draft.forwardX11).toBe('inherit');
    expect(draftToRequest(draft).options.forwardX11).toBeUndefined();

    draft.forwardX11 = 'no';
    expect(draftToRequest(draft).options.forwardX11).toBe(false);
    draft.forwardX11 = 'yes';
    const savedProfile = draftToSavedSshInput(draft).profile;
    if (savedProfile.kind !== 'ssh') throw new Error('Expected an SSH profile');
    expect(savedProfile.forwardX11).toBe(true);

    expect(draftFromEntry({ ...entry, options: { ...entry.options, forwardX11: false } }, false).forwardX11).toBe('no');
    expect(draftFromEntry(entry, false).forwardX11).toBe('inherit');
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

  it('starts a new host in the requested storage', () => {
    expect(blankDraft().storage).toBe('openssh');
    expect(blankDraft('', '', 'muxus').storage).toBe('muxus');
  });

  it('uses a bare prefilled name as the hostname of a Muxus profile', () => {
    const draft = blankDraft('myairframe4', '', 'muxus');
    expect(draft).toMatchObject({ aliasText: 'myairframe4', hostname: 'myairframe4' });
    expect(draftProblem(draft)).toBeNull();
    expect(blankDraft('ops@edge01.lab.test:2222', '', 'muxus')).toMatchObject({
      aliasText: 'edge01.lab.test',
      hostname: 'edge01.lab.test',
      user: 'ops',
      port: '2222',
    });
  });

  it('prefills the selected folder for a new host', () => {
    expect(blankDraft('', 'Production/Edge')).toMatchObject({
      group: 'Production/Edge',
    });
  });

  it('loads the login sequence from either host source and keeps it out of ssh_config', () => {
    const loginSequence = {
      steps: [
        { id: 'w', kind: 'wait' as const, pattern: '[>#]\\s*$', regex: true, timeoutSeconds: 15 },
        { id: 's', kind: 'send' as const, text: 'terminal length 0', enter: true },
      ],
    };
    expect(blankDraft().loginSequence).toEqual({ mode: 'inherit', steps: [] });
    const fromConfig = draftFromEntry(
      { ...entry, metadata: { profileId: 'p', connectCount: 0, loginSequence } },
      true,
    );
    expect(fromConfig.loginSequence).toEqual({ mode: 'custom', steps: loginSequence.steps });
    expect(draftProblem(fromConfig)).toBeNull();
    expect(JSON.stringify(draftToRequest(fromConfig))).not.toContain('terminal length');

    const fromProfile = draftFromSavedSshProfile(
      {
        id: 'r',
        kind: 'ssh',
        name: 'Router',
        profile: { kind: 'ssh', profileId: 'r', target: 'router.test', useConfig: false },
        metadata: { profileId: 'r', connectCount: 0, loginSequence: { steps: [] } },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      false,
    );
    expect(fromProfile.loginSequence.mode).toBe('none');
    expect(JSON.stringify(draftToSavedSshInput(fromProfile))).not.toContain('loginSequence');
    expect(
      draftProblem({ ...fromConfig, loginSequence: { mode: 'custom', steps: [{ id: 'x', kind: 'secret', secretId: '', enter: true }] } }),
    ).toBe('Login sequence step 1: Choose a secret from the password vault.');
  });

  it('loads prompt waiting from either host source and keeps it out of ssh_config', () => {
    const pastePromptWait = { promptPattern: 'core-sw\\d#\\s*$', timeoutMs: 15_000 };
    expect(blankDraft().pastePromptWait.enabled).toBe(false);
    const fromConfig = draftFromEntry(
      { ...entry, metadata: { profileId: 'p', connectCount: 0, pastePromptWait } },
      false,
    );
    expect(fromConfig.pastePromptWait).toEqual({
      enabled: true,
      promptPattern: 'core-sw\\d#\\s*$',
      timeoutMs: '15000',
      errorPattern: '',
    });
    expect(draftProblem(fromConfig)).toBeNull();
    expect(JSON.stringify(draftToRequest(fromConfig))).not.toContain('core-sw');

    const fromProfile = draftFromSavedSshProfile(
      {
        id: 'r',
        kind: 'ssh',
        name: 'Router',
        profile: { kind: 'ssh', profileId: 'r', target: 'router.test', useConfig: false },
        metadata: { profileId: 'r', connectCount: 0, pastePromptWait: {} },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      false,
    );
    expect(fromProfile.pastePromptWait.enabled).toBe(true);
    expect(JSON.stringify(draftToSavedSshInput(fromProfile))).not.toContain('pastePromptWait');
    expect(
      draftProblem({ ...fromConfig, pastePromptWait: { ...fromConfig.pastePromptWait, timeoutMs: '99' } }),
    ).toBe('Prompt timeout: Between 100 and 60000 ms.');
  });

  it('loads anti-idle from either host source and keeps it out of ssh_config', () => {
    const antiIdle = { intervalSeconds: 240, text: 'show clock', enter: true };
    expect(blankDraft().antiIdle.enabled).toBe(false);
    const fromConfig = draftFromEntry(
      { ...entry, metadata: { profileId: 'p', connectCount: 0, antiIdle } },
      false,
    );
    expect(fromConfig.antiIdle).toEqual({
      enabled: true,
      intervalSeconds: '240',
      text: 'show clock',
      enter: true,
    });
    expect(draftProblem(fromConfig)).toBeNull();
    expect(JSON.stringify(draftToRequest(fromConfig))).not.toContain('show clock');

    const fromProfile = draftFromSavedSshProfile(
      {
        id: 'r',
        kind: 'ssh',
        name: 'Router',
        profile: { kind: 'ssh', profileId: 'r', target: 'router.test', useConfig: false },
        metadata: { profileId: 'r', connectCount: 0, antiIdle },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      false,
    );
    expect(fromProfile.antiIdle.enabled).toBe(true);
    expect(JSON.stringify(draftToSavedSshInput(fromProfile))).not.toContain('show clock');
    expect(draftProblem({ ...fromConfig, antiIdle: { ...fromConfig.antiIdle, text: '', enter: false } })).toBe(
      'Anti-idle: enter text to type, or press Enter.',
    );
  });
});
