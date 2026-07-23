export const DEFAULT_SFTP_PANEL_WIDTH = 380;
export const MIN_SFTP_PANEL_WIDTH = 280;
export const MIN_SFTP_WORKSPACE_WIDTH = 240;

/**
 * Keep the browser useful without letting it take more than 70% of its pane
 * or squeeze the terminal/editor below its practical minimum.
 */
export function maxSftpPanelWidth(containerWidth: number): number {
  return Math.max(
    MIN_SFTP_PANEL_WIDTH,
    Math.floor(Math.min(containerWidth * 0.7, containerWidth - MIN_SFTP_WORKSPACE_WIDTH)),
  );
}

export function clampSftpPanelWidth(width: number, containerWidth: number): number {
  return Math.max(MIN_SFTP_PANEL_WIDTH, Math.min(maxSftpPanelWidth(containerWidth), Math.round(width)));
}
