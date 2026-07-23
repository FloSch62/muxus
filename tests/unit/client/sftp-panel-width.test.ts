import { describe, expect, it } from 'vitest';
import {
  clampSftpPanelWidth,
  maxSftpPanelWidth,
  MIN_SFTP_PANEL_WIDTH,
} from '../../../client/src/sftp-panel-width.js';

describe('SFTP panel width', () => {
  it('keeps enough room for both the browser and workspace', () => {
    expect(maxSftpPanelWidth(1_200)).toBe(840);
    expect(maxSftpPanelWidth(700)).toBe(460);
    expect(maxSftpPanelWidth(400)).toBe(MIN_SFTP_PANEL_WIDTH);
  });

  it('rounds and clamps dragged widths', () => {
    expect(clampSftpPanelWidth(100, 1_200)).toBe(MIN_SFTP_PANEL_WIDTH);
    expect(clampSftpPanelWidth(441.6, 1_200)).toBe(442);
    expect(clampSftpPanelWidth(1_000, 1_200)).toBe(840);
  });
});
