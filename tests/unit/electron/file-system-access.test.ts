import { EventEmitter } from 'node:events';
import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { allowRestrictedFolders } from '../../../electron/src/file-system-access.js';

describe('restricted folders', () => {
  it('allows a folder picked in the native dialog, such as Downloads itself', () => {
    const session = new EventEmitter();
    allowRestrictedFolders(session as unknown as Session);
    const callback = vi.fn();

    session.emit(
      'file-system-access-restricted',
      {},
      { origin: 'http://127.0.0.1:51186', path: 'C:\\Users\\me\\Downloads', isDirectory: true },
      callback,
    );

    expect(callback).toHaveBeenCalledWith('allow');
  });
});
