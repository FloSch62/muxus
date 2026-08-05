/** Choose the terminal directory only while the attached browser is following it. */
export function initialSftpPath(
  initialPath: string,
  terminalPath: string | undefined,
  followTerminalFolder: boolean,
): string {
  return followTerminalFolder && terminalPath ? terminalPath : initialPath;
}
