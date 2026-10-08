import type { ConnectionCheckStatus, ConnectionDiagnosticsResponse } from '@muxus/shared';
import { terminalNotice } from '../connection-recovery.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const MUTED = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

const MARKS: Record<ConnectionCheckStatus, string> = {
  ok: `${GREEN}✔${RESET}`,
  fail: `${RED}✘${RESET}`,
  warn: `${YELLOW}!${RESET}`,
  info: `${MUTED}•${RESET}`,
  skipped: `${MUTED}–${RESET}`,
};

/** Shown while the checks run; the report replaces it. */
export const DIAGNOSIS_PROGRESS = `${MUTED}Checking the connection …${RESET}`;

/**
 * A diagnosis as terminal lines in the style of the SSH session summary: one
 * marked row per check, consecutive rows of one kind under a single label,
 * and the conclusion last. Ends with a line break.
 */
export function formatConnectionDiagnostics(report: ConnectionDiagnosticsResponse): string {
  const width = Math.max(0, ...report.checks.map((check) => check.label.length));
  const lines = [`${BOLD}➤ Connection diagnostics for ${MAGENTA}${terminalNotice(report.checked)}${RESET}`];
  let previous: string | undefined;
  for (const check of report.checks) {
    const label = check.label === previous ? '' : check.label;
    previous = check.label;
    const separator = label ? ':' : ' ';
    lines.push(
      `  ${MARKS[check.status]} ${label.padEnd(width)} ${separator} ${terminalNotice(check.detail)}`,
    );
  }
  lines.push(`  ${BOLD}→${RESET} ${terminalNotice(report.conclusion)}`);
  return lines.map((line) => `${line}\r\n`).join('');
}
