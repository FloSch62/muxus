import type { ConfigForward, SshSessionSummary } from '@muxus/shared';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const MUTED = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';

/** More forwards than this are counted instead of listed. */
const LISTED_FORWARDS = 4;

const AUTH_METHOD_LABELS: Record<string, string> = {
  none: 'none',
  agent: 'public key (SSH agent)',
  publickey: 'public key',
  password: 'password',
  'keyboard-interactive': 'keyboard-interactive',
  hostbased: 'host-based',
};

const ON = `${GREEN}✔${RESET}`;

function off(reason: string): string {
  return `${RED}✘${RESET}  ${MUTED}(${reason})${RESET}`;
}

function hostPort(host: string, port: number): string {
  if (port === 22) return host;
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function route(summary: SshSessionSummary): string {
  const hops = [...summary.jumpHosts];
  if (summary.proxyCommand) {
    if (hops.length) hops[0] = `${hops[0]} (ProxyCommand)`;
    else hops.push('ProxyCommand');
  }
  const path = hops.length ? `via ${hops.join(' → ')}` : 'direct';
  return summary.shared ? `${path}  ${MUTED}(reusing an open connection)${RESET}` : path;
}

function forwardSpec(forward: ConfigForward): string {
  const flag = forward.type === 'local' ? '-L' : forward.type === 'remote' ? '-R' : '-D';
  if (forward.type === 'dynamic' || !forward.targetHost || forward.targetPort === undefined) {
    return `${flag} ${forward.bindPort}`;
  }
  const target = forward.targetHost.includes(':') ? `[${forward.targetHost}]` : forward.targetHost;
  return `${flag} ${forward.bindPort}:${target}:${forward.targetPort}`;
}

function forwards(list: readonly ConfigForward[]): string {
  const listed = list.slice(0, LISTED_FORWARDS).map(forwardSpec).join(', ');
  const rest = list.length - LISTED_FORWARDS;
  return rest > 0 ? `${listed}  ${MUTED}(+${rest} more)${RESET}` : listed;
}

/**
 * The connect summary printed above an SSH session's first output: how the
 * host was reached, what the connection negotiated and which optional
 * features are active. Ends with a line break.
 */
export function formatSshSessionSummary(summary: SshSessionSummary): string {
  const rows: Array<[label: string, value: string]> = [['Route', route(summary)]];
  if (summary.serverSoftware) rows.push(['Server', summary.serverSoftware]);
  if (summary.authMethods.length) {
    rows.push([
      'Authentication',
      summary.authMethods.map((method) => AUTH_METHOD_LABELS[method] ?? method).join(' + '),
    ]);
  }
  if (summary.cipher) {
    rows.push([
      'Encryption',
      summary.kex ? `${summary.cipher}  ${MUTED}(${summary.kex})${RESET}` : summary.cipher,
    ]);
  }
  rows.push([
    'Compression',
    summary.compression === 'on'
      ? ON
      : off(summary.compression === 'unsupported' ? 'not supported by the server' : 'disabled'),
  ]);
  rows.push(['SFTP browser', summary.sftp ? ON : off('disabled for this host')]);
  rows.push([
    'X11 forwarding',
    summary.x11 === 'on'
      ? ON
      : off(
          summary.x11 === 'refused'
            ? 'refused by the server'
            : summary.x11 === 'no-server'
              ? 'no local X server'
              : 'disabled',
        ),
  ]);
  rows.push([
    'Agent forwarding',
    summary.agentForwarding === 'on'
      ? ON
      : off(summary.agentForwarding === 'no-agent' ? 'no SSH agent available' : 'disabled'),
  ]);
  if (summary.forwards.length) rows.push(['Port forwards', forwards(summary.forwards)]);

  const width = Math.max(...rows.map(([label]) => label.length));
  const target = `${summary.user}@${hostPort(summary.host, summary.port)}`;
  const lines = [
    `${BOLD}➤ SSH session to ${MAGENTA}${target}${RESET}`,
    ...rows.map(([label, value]) => `  ${MUTED}•${RESET} ${label.padEnd(width)} : ${value}`),
  ];
  return lines.map((line) => `${line}\r\n`).join('');
}
