import { describe, expect, it } from 'vitest';
import { initialSftpPath } from '../../../client/src/sftp-panel-state.js';

describe('SFTP panel state', () => {
  it('starts at the terminal directory only while following is enabled', () => {
    expect(initialSftpPath('.', '/srv/project', true)).toBe('/srv/project');
    expect(initialSftpPath('.', '/srv/project', false)).toBe('.');
  });

  it('falls back to the requested initial path before a terminal directory is reported', () => {
    expect(initialSftpPath('/uploads', undefined, true)).toBe('/uploads');
  });
});
