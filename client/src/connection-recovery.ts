import type { TerminalServerMessage } from '@muxus/shared';

export type ReattachMode = 'tmux' | 'screen';
export type TerminalExitMessage = Extract<TerminalServerMessage, { op: 'exit' }>;
export const CONNECTION_INTERRUPTION_GRACE_MS = 5_000;

const ANSI_CSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

/** Turn protocol and WebSocket close information into one user-facing explanation. */
export function connectionFailureReason(
  exit: TerminalExitMessage | undefined,
  close: { code: number; reason?: string; wasClean?: boolean },
): string {
  const message = exit?.message?.trim();
  if (message) return message;
  if (exit?.reason === 'completed') {
    return exit.code === undefined || exit.code === 0
      ? 'The shell exited normally.'
      : `The shell exited with status ${exit.code}.`;
  }
  if (exit?.reason === 'failed') return 'The connection attempt failed.';
  if (exit?.reason === 'disconnected') return 'The remote connection closed unexpectedly.';

  const socketReason = close.reason?.trim();
  if (socketReason) return socketReason;
  if (close.code === 1006) return 'The connection to the Muxus backend was interrupted.';
  if (close.wasClean) return 'The connection was closed.';
  return `The connection closed unexpectedly (WebSocket code ${close.code}).`;
}

/** Delay the final lost state only for a session that had reached ready. */
export function shouldDelayConnectionLost(
  exit: TerminalExitMessage | undefined,
  wasReady: boolean,
): boolean {
  return wasReady && exit?.reason !== 'completed';
}

/** SSH is only visibly responsive once its terminal channel produces output. */
export function shouldWaitForTerminalOutput(
  profileKind: 'ssh' | 'local' | 'telnet' | 'serial',
  receivedTerminalOutput: boolean,
): boolean {
  return profileKind === 'ssh' && !receivedTerminalOutput;
}

/** Shell input sent once a replacement SSH transport is ready. */
export function reattachCommand(mode: ReattachMode): string {
  if (mode === 'tmux') {
    return "if command -v tmux >/dev/null 2>&1; then tmux attach-session 2>/dev/null || tmux new-session; else printf '\\r\\nMuxus: tmux is not installed.\\r\\n'; fi\r";
  }
  return "if command -v screen >/dev/null 2>&1; then screen -xRR; else printf '\\r\\nMuxus: screen is not installed.\\r\\n'; fi\r";
}

/** Keep server-provided failure text from becoming terminal control input. */
export function terminalNotice(message: string): string {
  let clean = '';
  for (const character of message.replace(ANSI_CSI_PATTERN, '')) {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 13) {
      if (clean && !clean.endsWith(' ')) clean += ' ';
    } else if (code === 9 || (code >= 32 && code !== 127)) {
      clean += character;
    }
  }
  return clean;
}
