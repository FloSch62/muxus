import type { SessionProfile, TerminalServerMessage } from '@muxus/shared';

export type ReattachMode = 'tmux' | 'screen';
export type TerminalExitMessage = Extract<TerminalServerMessage, { op: 'exit' }>;
export const CONNECTION_INTERRUPTION_GRACE_MS = 5_000;

/** Fast local-backend retries used before opening an entirely new session. */
export const RENDERER_REATTACH_DELAYS_MS: readonly number[] = [0, 250, 1_000, 2_000];

/** Delays before each automatic reconnect attempt after a lost connection. */
export const AUTO_RECONNECT_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

/** Uptime after which a drop is a fresh incident with a fresh attempt budget. */
export const AUTO_RECONNECT_STABLE_MS = 30_000;

/** Delay before retrying a stable terminal id, or undefined when exhausted. */
export function rendererReattachDelayMs(attempts: number): number | undefined {
  return RENDERER_REATTACH_DELAYS_MS[attempts];
}

export interface AutoReconnectInput {
  /** The auto-reconnect preference. */
  enabled: boolean;
  profileKind: SessionProfile['kind'];
  reason: 'completed' | 'failed' | 'disconnected';
  /** Automatic attempts already made since the last stable connection. */
  attempts: number;
  /** An interactive auth prompt was shown; redialling would only re-prompt. */
  sawAuthPrompt: boolean;
}

/** Delay before the next automatic redial, or undefined to wait for the user. */
export function autoReconnectDelayMs(input: AutoReconnectInput): number | undefined {
  if (!input.enabled || input.profileKind === 'local') return undefined;
  if (input.reason === 'completed') return undefined;
  // A failed dial may continue a chain that a real drop started, but never
  // start one — that would loop on hosts that refuse to connect at all — and
  // never talk over an auth prompt the user walked away from.
  if (input.reason === 'failed' && (input.attempts === 0 || input.sawAuthPrompt)) {
    return undefined;
  }
  return AUTO_RECONNECT_DELAYS_MS[input.attempts];
}

/**
 * Whether an ended session offers the diagnose key: a network session that
 * failed or dropped, not a shell that exited on its own.
 */
export function canDiagnoseConnection(
  profileKind: SessionProfile['kind'],
  reason: 'completed' | 'failed' | 'disconnected',
): boolean {
  return reason !== 'completed' && (profileKind === 'ssh' || profileKind === 'telnet');
}

/** The key that runs connection diagnostics instead of reconnecting. */
export function isDiagnoseKey(data: string): boolean {
  return data === 'd' || data === 'D';
}

/** The line that tells an ended session's user what a key press does. */
export function reconnectPrompt(diagnose: boolean): string {
  return diagnose
    ? 'Press D to diagnose the connection, any other key to reconnect'
    : 'Press any key to reconnect';
}

/** The countdown line shown while an automatic reconnect is pending. */
export function autoReconnectNotice(
  delayMs: number,
  attempt: number,
  diagnose: boolean,
): string {
  const keys = diagnose ? 'D diagnoses, any other key reconnects now' : 'any key reconnects now';
  return `Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${AUTO_RECONNECT_DELAYS_MS.length}) — ${keys}`;
}

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
  profileKind: SessionProfile['kind'],
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
