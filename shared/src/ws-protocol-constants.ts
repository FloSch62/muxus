import type {
  DesktopProfile,
  ManagementProfile,
  SessionProfile,
  TerminalProfile,
} from './ws-protocol.js';

/** Fixed subprotocol selected by the server for terminal sockets. */
export const TERMINAL_WS_PROTOCOL = 'muxus.terminal.v1';
/** Authentication is offered as a non-selected subprotocol so it stays out of request URLs. */
export const TERMINAL_WS_AUTH_PREFIX = 'muxus.auth.';
/** Clean-close reason that explicitly ends the backend terminal lifecycle. */
export const TERMINAL_SESSION_CLOSE_REASON = 'terminal session closed';

/** Upper bound for the Muxus-wide ServerAliveInterval fallback, in seconds. */
export const MAX_SSH_KEEPALIVE_INTERVAL_SECONDS = 3600;
/** Alternative jump routes or gateways a host may list after its first. */
export const MAX_JUMP_FALLBACKS = 4;
/** Hops in one ProxyJump chain. */
export const MAX_JUMP_HOPS = 8;

/** The ServerAliveInterval fallback Muxus uses unless Settings say otherwise. */
export const DEFAULT_SSH_KEEPALIVE_INTERVAL_SECONDS = 30;

/** How long Send BREAK holds the line unless a serial host says otherwise (tcsendbreak's length). */
export const DEFAULT_BREAK_DURATION_MS = 250;

/** Upper bound for a serial host's break duration, in milliseconds. */
export const MAX_BREAK_DURATION_MS = 10_000;

/** Protocols offered by browser WebSocket clients during the HTTP upgrade. */
export function terminalWebSocketProtocols(token: string): string[] {
  return [TERMINAL_WS_PROTOCOL, `${TERMINAL_WS_AUTH_PREFIX}${token}`];
}

/**
 * /ws/desktop: one control socket per RDP/VNC tab. The client sends `connect`;
 * the server dials any SSH gateway (with the same auth-prompt/host-key
 * round-trips as a terminal), gathers credentials, then answers `ready` with a
 * single-use ticket. The picture itself travels on a second socket that
 * presents the ticket: /ws/desktop/rdp for IronRDP's RDCleanPath handshake,
 * /ws/desktop/vnc (ticket as a subprotocol) for noVNC's raw RFB stream.
 */
export const DESKTOP_RDP_WS_PATH = '/ws/desktop/rdp';
export const DESKTOP_VNC_WS_PATH = '/ws/desktop/vnc';
/** A VNC stream socket offers its ticket as this subprotocol prefix. */
export const DESKTOP_TICKET_PROTOCOL_PREFIX = 'muxus.ticket.';

export function isDesktopProfile(profile: SessionProfile): profile is DesktopProfile {
  return profile.kind === 'rdp' || profile.kind === 'vnc';
}

export function isManagementProfile(profile: SessionProfile): profile is ManagementProfile {
  return profile.kind === 'gnmi' || profile.kind === 'netconf';
}

/** Sessions with a terminal: everything but remote desktops and management sessions. */
export function isTerminalProfile(profile: SessionProfile): profile is TerminalProfile {
  return !isDesktopProfile(profile) && !isManagementProfile(profile);
}
