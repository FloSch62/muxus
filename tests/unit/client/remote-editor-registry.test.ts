import { describe, expect, it, vi } from 'vitest';
import {
  registerRemoteEditor,
  requestCloseRemoteEditor,
} from '../../../client/src/editor/remote-editor-registry.js';

describe('remote editor registry', () => {
  it('routes a close request to the registered editor and cleans up safely', () => {
    const closeActive = vi.fn();
    const unregister = registerRemoteEditor('tab-1', {
      closeActive,
      hasDirty: () => false,
    });

    expect(requestCloseRemoteEditor('tab-1')).toBe(true);
    expect(closeActive).toHaveBeenCalledOnce();

    unregister();
    expect(requestCloseRemoteEditor('tab-1')).toBe(false);
  });

  it('does not let an older cleanup remove a replacement handle', () => {
    const unregisterOld = registerRemoteEditor('tab-1', {
      closeActive: vi.fn(),
      hasDirty: () => false,
    });
    const replacementClose = vi.fn();
    const unregisterReplacement = registerRemoteEditor('tab-1', {
      closeActive: replacementClose,
      hasDirty: () => false,
    });

    unregisterOld();
    expect(requestCloseRemoteEditor('tab-1')).toBe(true);
    expect(replacementClose).toHaveBeenCalledOnce();
    unregisterReplacement();
  });
});
