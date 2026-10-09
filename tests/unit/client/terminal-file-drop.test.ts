import { describe, expect, it } from 'vitest';
import { TAB_TRANSFER_MIME } from '../../../client/src/tab-drag.js';
import {
  dropEffectFor,
  dropOverlayText,
  INSERT_PATHS_HINT,
  internalDragInProgress,
  isExternalFileDrag,
  terminalDropIntent,
  trackInternalDrags,
  type TerminalDropContext,
} from '../../../client/src/terminal/file-drop.js';

function ssh(patch: Partial<TerminalDropContext> = {}): TerminalDropContext {
  return {
    profileKind: 'ssh',
    status: 'connected',
    connId: 'conn-1',
    sftpAvailable: true,
    insertModifier: false,
    canInsertPaths: true,
    ...patch,
  };
}

function dataTransfer(types: string[]): DataTransfer {
  return { types } as unknown as DataTransfer;
}

describe('dropping files onto an SSH terminal', () => {
  it("uploads into the shell's directory", () => {
    expect(terminalDropIntent(ssh({ cwd: '/srv/app', home: '/home/admin' }))).toEqual({
      kind: 'upload',
      directory: '/srv/app',
      hint: INSERT_PATHS_HINT,
    });
  });

  it('uploads into the home directory when the shell reports none', () => {
    expect(terminalDropIntent(ssh({ home: '/home/admin' }))).toMatchObject({
      kind: 'upload',
      directory: '/home/admin',
    });
    expect(terminalDropIntent(ssh())).toEqual({ kind: 'upload', hint: INSERT_PATHS_HINT });
  });

  it('inserts the local paths while the modifier is held', () => {
    expect(terminalDropIntent(ssh({ insertModifier: true, cwd: '/srv' }))).toEqual({
      kind: 'insert',
      byModifier: true,
    });
  });

  it('ignores the modifier in a browser, where dropped files have no paths', () => {
    expect(terminalDropIntent(ssh({ insertModifier: true, canInsertPaths: false, cwd: '/srv' }))).toEqual({
      kind: 'upload',
      directory: '/srv',
    });
  });

  it('says SFTP is disabled instead of offering an upload', () => {
    expect(terminalDropIntent(ssh({ sftpAvailable: false, cwd: '/srv' }))).toEqual({
      kind: 'unavailable',
      message: 'SFTP is disabled for this host',
      hint: INSERT_PATHS_HINT,
    });
    expect(terminalDropIntent(ssh({ sftpAvailable: false, canInsertPaths: false }))).toEqual({
      kind: 'unavailable',
      message: 'SFTP is disabled for this host',
    });
    expect(terminalDropIntent(ssh({ sftpAvailable: false, insertModifier: true }))).toEqual({
      kind: 'insert',
      byModifier: true,
    });
  });

  it('waits for the connection, and not for an ended session', () => {
    expect(terminalDropIntent(ssh({ status: 'connecting', connId: undefined }))).toMatchObject({
      kind: 'unavailable',
      message: 'Waiting for the session to connect…',
    });
    expect(terminalDropIntent(ssh({ status: 'closed', connId: undefined }))).toMatchObject({
      kind: 'unavailable',
      message: 'The session has ended. Reconnect to drop files here.',
    });
  });
});

describe('dropping files onto other terminals', () => {
  it('types the paths into a local shell', () => {
    const local = ssh({ profileKind: 'local', connId: undefined, sftpAvailable: undefined });
    expect(terminalDropIntent(local)).toEqual({ kind: 'insert', byModifier: false });
    expect(terminalDropIntent({ ...local, insertModifier: true })).toEqual({ kind: 'insert', byModifier: false });
    expect(terminalDropIntent({ ...local, canInsertPaths: false })).toEqual({
      kind: 'unavailable',
      message: 'File paths can only be inserted in the desktop app',
    });
  });

  it('offers nothing on Telnet, serial and remote desktop sessions', () => {
    for (const profileKind of ['telnet', 'serial', 'rdp', 'vnc'] as const) {
      expect(terminalDropIntent(ssh({ profileKind, insertModifier: true }))).toEqual({ kind: 'refuse' });
    }
  });
});

describe('the drag overlay', () => {
  it('names the upload target', () => {
    expect(dropOverlayText({ kind: 'upload', directory: '/home/admin/project' })).toEqual({
      title: 'Upload to /home/admin/project',
    });
    expect(dropOverlayText({ kind: 'upload', hint: INSERT_PATHS_HINT })).toEqual({
      title: 'Upload to the home folder',
      caption: 'Hold Shift to insert the local paths instead',
    });
  });

  it('tells inserting by the modifier apart', () => {
    expect(dropOverlayText({ kind: 'insert', byModifier: true })).toEqual({
      title: 'Insert the local paths',
      caption: 'Release Shift to upload instead',
    });
    expect(dropOverlayText({ kind: 'insert', byModifier: false })).toEqual({ title: 'Insert the file paths' });
  });

  it('accepts only drops it acts on', () => {
    expect(dropEffectFor({ kind: 'upload' })).toBe('copy');
    expect(dropEffectFor({ kind: 'insert', byModifier: true })).toBe('link');
    expect(dropEffectFor({ kind: 'unavailable', message: 'x' })).toBe('none');
    expect(dropEffectFor({ kind: 'refuse' })).toBe('none');
  });
});

describe('which drags count as dropped files', () => {
  it('takes files from outside the window', () => {
    expect(isExternalFileDrag(dataTransfer(['Files']), false)).toBe(true);
    expect(isExternalFileDrag(dataTransfer(['text/uri-list', 'Files']), false)).toBe(true);
  });

  it('leaves tab drags, text and drags that start inside the window alone', () => {
    expect(isExternalFileDrag(dataTransfer([TAB_TRANSFER_MIME]), false)).toBe(false);
    expect(isExternalFileDrag(dataTransfer([TAB_TRANSFER_MIME, 'Files']), false)).toBe(false);
    expect(isExternalFileDrag(dataTransfer(['text/plain']), false)).toBe(false);
    expect(isExternalFileDrag(dataTransfer(['DownloadURL', 'text/uri-list']), false)).toBe(false);
    expect(isExternalFileDrag(dataTransfer(['Files']), true)).toBe(false);
    expect(isExternalFileDrag(null, false)).toBe(false);
  });
});

describe('drags that start inside the window', () => {
  it('count from dragstart until the drag ends, is dropped, or the pointer moves again', () => {
    const target = new EventTarget();
    trackInternalDrags(target as unknown as Window);
    expect(internalDragInProgress()).toBe(false);
    for (const end of ['dragend', 'drop', 'pointermove']) {
      target.dispatchEvent(new Event('dragstart'));
      expect(internalDragInProgress()).toBe(true);
      target.dispatchEvent(new Event(end));
      expect(internalDragInProgress()).toBe(false);
    }
  });
});
