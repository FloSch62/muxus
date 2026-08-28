import { describe, expect, it } from 'vitest';
import type { SavedHostProfile } from '@muxus/shared';
import {
  blankNativeDraft,
  nativeDraftFromProfile,
  nativeDraftMetadataPatch,
  nativeDraftProblem,
  nativeDraftToInput,
} from '../../../client/src/components/host-editor/native-draft.js';

const serialHost: SavedHostProfile = {
  id: 'serial-console',
  kind: 'serial',
  name: 'Rack console',
  profile: {
    kind: 'serial',
    profileId: 'serial-console',
    path: '/dev/ttyUSB0',
    baudRate: 9_600,
    dataBits: 7,
    stopBits: 2,
    parity: 'even',
    flowControl: 'hardware',
  },
  metadata: {
    profileId: 'serial-console',
    group: 'Lab',
    terminalScheme: 'gruvbox-dark',
    terminalFontColor: '#ebdbb2',
    terminalBackgroundColor: '#282828',
    keywordHighlights: {
      inheritGlobal: false,
      profileId: 'nokia-sros',
      rules: [
        {
          id: 'r1',
          keyword: 'ERROR',
          foreground: '#ff0000',
          caseSensitive: false,
          wholeWord: false,
        },
      ],
    },
    connectCount: 0,
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('blankNativeDraft', () => {
  it('starts from telnet and serial defaults', () => {
    const draft = blankNativeDraft();
    expect(draft.port).toBe('23');
    expect(draft.baudRate).toBe('115200');
    expect(draft.dataBits).toBe(8);
    expect(draft.keywordHighlights).toEqual({ inheritGlobal: true, rules: [] });
  });

  it('seeds the telnet host from a quick-connect target', () => {
    expect(blankNativeDraft('admin@10.0.0.5:2323')).toMatchObject({
      host: '10.0.0.5',
      port: '2323',
    });
    expect(blankNativeDraft('switch.example.test')).toMatchObject({
      host: 'switch.example.test',
      port: '23',
    });
  });

  it('prefills the selected folder for Telnet and serial hosts', () => {
    expect(blankNativeDraft('', 'Lab/Consoles')).toMatchObject({
      group: 'Lab/Consoles',
    });
  });
});

describe('nativeDraftFromProfile', () => {
  it('restores every serial field plus Muxus metadata', () => {
    const draft = nativeDraftFromProfile(serialHost, false);
    expect(draft).toMatchObject({
      name: 'Rack console',
      group: 'Lab',
      terminalScheme: 'gruvbox-dark',
      terminalFontColor: '#ebdbb2',
      terminalBackgroundColor: '#282828',
      path: '/dev/ttyUSB0',
      baudRate: '9600',
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
    });
    expect(draft.keywordHighlights).toMatchObject({
      profileId: 'nokia-sros',
      rules: [expect.objectContaining({ keyword: 'ERROR' })],
    });
  });

  it('renames duplicates', () => {
    expect(nativeDraftFromProfile(serialHost, true).name).toBe('Rack console copy');
  });
});

describe('nativeDraftProblem', () => {
  it('validates the fields of the active kind only', () => {
    const draft = blankNativeDraft();
    expect(nativeDraftProblem(draft, 'telnet')).toMatch(/name/i);
    draft.name = 'Router';
    expect(nativeDraftProblem(draft, 'telnet')).toMatch(/hostname or IP/);
    draft.host = 'router.example.test';
    expect(nativeDraftProblem(draft, 'telnet')).toBeNull();
    draft.port = '70000';
    expect(nativeDraftProblem(draft, 'telnet')).toMatch(/Port/);
    // The empty serial path never blocks saving a telnet host.
    expect(nativeDraftProblem({ ...draft, port: '23' }, 'serial')).toMatch(/serial port/);
  });
});

describe('nativeDraftToInput', () => {
  it('maps only the active kind into the save payload', () => {
    const draft = blankNativeDraft();
    draft.name = ' Router ';
    draft.host = ' router.example.test ';
    draft.port = '2323';
    expect(nativeDraftToInput(draft, 'telnet', 'existing-id')).toEqual({
      id: 'existing-id',
      name: 'Router',
      profile: { kind: 'telnet', host: 'router.example.test', port: 2323 },
    });
  });
});

describe('nativeDraftMetadataPatch', () => {
  it('clears untouched metadata and keeps configured values', () => {
    expect(nativeDraftMetadataPatch(blankNativeDraft())).toEqual({
      group: null,
      color: null,
      terminalScheme: null,
      terminalFontColor: null,
      terminalBackgroundColor: null,
      keywordHighlights: null,
    });
    const draft = nativeDraftFromProfile(serialHost, false);
    expect(nativeDraftMetadataPatch(draft)).toEqual({
      group: 'Lab',
      color: null,
      terminalScheme: 'gruvbox-dark',
      terminalFontColor: '#ebdbb2',
      terminalBackgroundColor: '#282828',
      keywordHighlights: serialHost.metadata.keywordHighlights,
    });
  });

  it('carries the row color chosen in the editor', () => {
    const draft = { ...blankNativeDraft(), color: '#4285f4' };
    expect(nativeDraftMetadataPatch(draft)).toMatchObject({ color: '#4285f4' });
    expect(nativeDraftFromProfile(
      { ...serialHost, metadata: { ...serialHost.metadata, color: '#ef5350' } },
      false,
    ).color).toBe('#ef5350');
  });
});
