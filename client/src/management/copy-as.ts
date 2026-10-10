import type { GnmiProfile, NetconfProfile } from '@muxus/shared';
import { nonEmptyPaths, netconfRpcBody, type GnmiDraft, type NetconfDraft } from './requests.js';
import { prettyXml } from './xml.js';

/**
 * Hand a request over to automation: the same request as a gnmic command
 * line or an ncclient script. Passwords are never included; gnmic and
 * ncclient prompt or read them from the environment.
 */

/** Quote for POSIX shells. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function gnmicConnection(profile: GnmiProfile): string[] {
  const args = ['gnmic', '-a', shellQuote(`${profile.host}:${profile.port}`)];
  if (profile.username) args.push('-u', shellQuote(profile.username), '-p', '"$GNMIC_PASSWORD"');
  const tls = profile.tls ?? 'verify';
  if (tls === 'plaintext') args.push('--insecure');
  else if (tls === 'skip-verify') args.push('--skip-verify');
  if (profile.caFile) args.push('--tls-ca', shellQuote(profile.caFile));
  if (profile.certFile) args.push('--tls-cert', shellQuote(profile.certFile));
  if (profile.keyFile) args.push('--tls-key', shellQuote(profile.keyFile));
  if (profile.tlsServerName) args.push('--tls-server-name', shellQuote(profile.tlsServerName));
  return args;
}

/** The gnmic command for a host, optionally running a request. */
export function gnmicCommand(profile: GnmiProfile, draft?: GnmiDraft, sessionEncoding?: string): string {
  const args = gnmicConnection(profile);
  const encoding = draft?.encoding ?? profile.encoding ?? sessionEncoding;
  if (encoding) args.push('-e', encoding);
  if (!draft) {
    args.push('capabilities');
    return args.join(' ');
  }
  if (draft.prefix.trim()) args.push('--prefix', shellQuote(draft.prefix.trim()));
  if (draft.operation === 'get') {
    args.push('get');
    for (const path of nonEmptyPaths(draft.paths)) args.push('--path', shellQuote(path));
    if (draft.dataType !== 'all') args.push('--type', draft.dataType);
    if (draft.depth) args.push('--depth', String(draft.depth));
  } else if (draft.operation === 'set') {
    args.push('set');
    for (const item of draft.set.filter((candidate) => candidate.path.trim())) {
      if (item.op === 'delete') {
        args.push('--delete', shellQuote(item.path.trim()));
        continue;
      }
      args.push(`--${item.op}-path`, shellQuote(item.path.trim()), `--${item.op}-value`, shellQuote(compactJson(item.value)));
    }
  } else {
    const sub = draft.subscribe;
    args.push('subscribe');
    for (const path of nonEmptyPaths(draft.paths)) args.push('--path', shellQuote(path));
    args.push('--mode', sub.listMode);
    if (sub.listMode === 'stream') {
      args.push('--stream-mode', sub.mode);
      if (sub.mode === 'sample') args.push('--sample-interval', `${sub.sampleSeconds}s`);
      if (sub.suppressRedundant) args.push('--suppress-redundant');
      if (sub.heartbeatSeconds) args.push('--heartbeat-interval', `${sub.heartbeatSeconds}s`);
    }
    if (sub.updatesOnly) args.push('--updates-only');
  }
  return args.join(' ');
}

function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function pythonString(text: string): string {
  if (!text.includes('"""') && !text.endsWith('"')) return `"""${text}"""`;
  return JSON.stringify(text);
}

/** A runnable ncclient script for a NETCONF request. */
export function ncclientScript(profile: NetconfProfile, draft: NetconfDraft): string {
  const body = prettyXml(`<muxus-wrap>${netconfRpcBody(draft)}</muxus-wrap>`)
    .split('\n')
    .slice(1, -1)
    .map((line) => line.slice(2))
    .join('\n');
  return [
    'import getpass',
    '',
    'from ncclient import manager',
    'from ncclient.xml_ import to_ele',
    '',
    'RPC = ' + pythonString(`\n${body}\n`),
    '',
    'with manager.connect(',
    `    host=${JSON.stringify(profile.host)},`,
    `    port=${profile.port},`,
    ...(profile.username ? [`    username=${JSON.stringify(profile.username)},`] : []),
    '    password=getpass.getpass(),',
    '    hostkey_verify=False,',
    ') as m:',
    '    reply = m.dispatch(to_ele(RPC))',
    '    print(reply.xml)',
    '',
  ].join('\n');
}

/** `ssh -s netconf` that a person can paste RPCs into by hand. */
export function netconfSshCommand(profile: NetconfProfile): string {
  const user = profile.username ? `${shellQuote(profile.username)}@` : '';
  return `ssh -p ${profile.port} ${user}${shellQuote(profile.host)} -s netconf`;
}
