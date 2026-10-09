import { describe, expect, it } from 'vitest';
import {
  connectionLinkTarget,
  looksLikeConnectionLink,
  normalizeHostKeyFingerprint,
  parseConnectionLink,
  type ConnectionLink,
} from '@muxus/shared';

const SHA256 = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
const MD5_PAIRS = 'c1:b1:30:29:d7:b8:de:6c:97:77:10:d7:46:41:63:87';

function link(url: string): ConnectionLink {
  const result = parseConnectionLink(url);
  if (!result.ok) throw new Error(`rejected ${url}: ${result.error}`);
  return result.link;
}

function rejection(url: string): string {
  const result = parseConnectionLink(url);
  if (result.ok) throw new Error(`accepted ${url}`);
  return result.error;
}

describe('ssh:// links', () => {
  it('reads user, host and port', () => {
    expect(link('ssh://admin@10.0.0.1:2222')).toEqual({
      scheme: 'ssh',
      host: '10.0.0.1',
      port: 2222,
      user: 'admin',
    });
    expect(link('ssh://edge-router')).toEqual({ scheme: 'ssh', host: 'edge-router' });
    expect(link('SSH://Edge-Router.example.com/')).toEqual({
      scheme: 'ssh',
      host: 'Edge-Router.example.com',
    });
  });

  it('leaves the port to the host settings when the link has none', () => {
    expect(link('ssh://admin@host').port).toBeUndefined();
    // RFC 3986 allows an empty port, which means the default one.
    expect(link('ssh://host:').port).toBeUndefined();
    expect(link('ssh://host:022').port).toBe(22);
  });

  it('accepts IPv6 literals in brackets, with an RFC 6874 zone', () => {
    expect(link('ssh://root@[2001:db8::1]:830')).toEqual({
      scheme: 'ssh',
      host: '2001:db8::1',
      port: 830,
      user: 'root',
    });
    expect(link('ssh://[fe80::1%25eth0]').host).toBe('fe80::1%eth0');
    expect(link('ssh://[::1]/').host).toBe('::1');
  });

  it('percent-decodes user and host', () => {
    expect(link('ssh://jane%40corp@host').user).toBe('jane@corp');
    expect(link('ssh://user@my%2Dhost').host).toBe('my-host');
  });

  it('ignores a path, query and fragment, as the draft asks', () => {
    expect(link('ssh://host/some/path?x=1#frag')).toEqual({ scheme: 'ssh', host: 'host' });
    expect(link('ssh://user@host/a@b')).toEqual({ scheme: 'ssh', host: 'host', user: 'user' });
  });

  it('accepts a SHA256 fingerprint connection parameter', () => {
    expect(link(`ssh://admin;fingerprint=${SHA256}@host:2222`)).toEqual({
      scheme: 'ssh',
      host: 'host',
      port: 2222,
      user: 'admin',
      hostKeyFingerprint: SHA256,
    });
    // Percent-encoded, or without a user at all.
    expect(link(`ssh://;fingerprint=${encodeURIComponent(SHA256)}@host`)).toEqual({
      scheme: 'ssh',
      host: 'host',
      hostKeyFingerprint: SHA256,
    });
  });

  it('keeps an unescaped "/" of a base64 fingerprint in the user part', () => {
    const fingerprint = 'SHA256:ab/cdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    expect(link(`ssh://admin;fingerprint=${fingerprint}@host/`)).toEqual({
      scheme: 'ssh',
      host: 'host',
      user: 'admin',
      hostKeyFingerprint: fingerprint,
    });
  });

  it('accepts the draft fingerprint form and MD5 fingerprints', () => {
    expect(
      link(`ssh://u;fingerprint=ssh-rsa-${MD5_PAIRS.replaceAll(':', '-')}@host`).hostKeyFingerprint,
    ).toBe(`ssh-rsa MD5:${MD5_PAIRS}`);
    expect(link(`ssh://u;fingerprint=MD5:${MD5_PAIRS.toUpperCase()}@host`).hostKeyFingerprint).toBe(
      `MD5:${MD5_PAIRS}`,
    );
  });

  it('ignores connection parameters it does not know', () => {
    expect(link('ssh://admin;color=red,fingerprint=' + SHA256 + '@host')).toMatchObject({
      user: 'admin',
      hostKeyFingerprint: SHA256,
    });
    expect(link('ssh://admin;x-option=1@host')).toEqual({ scheme: 'ssh', host: 'host', user: 'admin' });
  });

  it('rejects a malformed or repeated fingerprint', () => {
    expect(rejection('ssh://admin;fingerprint=SHA256:short@host')).toMatch(/fingerprint/);
    expect(rejection('ssh://admin;fingerprint@host')).toMatch(/fingerprint/);
    expect(rejection(`ssh://a;fingerprint=${SHA256},fingerprint=${SHA256}@host`)).toMatch(
      /more than one fingerprint/,
    );
  });
});

describe('telnet:// links', () => {
  it('reads host and port', () => {
    expect(link('telnet://switch-01:23')).toEqual({ scheme: 'telnet', host: 'switch-01', port: 23 });
    expect(link('telnet://10.0.0.5/')).toEqual({ scheme: 'telnet', host: '10.0.0.5' });
    expect(link('TELNET://[::1]:2323')).toEqual({ scheme: 'telnet', host: '::1', port: 2323 });
  });

  it('keeps an advisory user but no connection parameters', () => {
    expect(link('telnet://operator@switch')).toEqual({
      scheme: 'telnet',
      host: 'switch',
      user: 'operator',
    });
    expect(rejection(`telnet://op;fingerprint=${SHA256}@switch`)).toMatch(/no connection parameters/);
  });
});

describe('link validation', () => {
  it.each([
    ['ssh://-oProxyCommand=touch%20pwned@host', /user name/],
    ['ssh://-oProxyCommand=id', /host name/],
    ['ssh://%2DoProxyCommand=id', /host name/],
    ['ssh://admin@-host', /host name/],
    ['ssh://%2Dadmin@host', /user name/],
    ['ssh://admin@host;reboot', /host name/],
    ['ssh://adm$(id)in@host', /user name/],
    ['ssh://admin@ho%60st', /host name/],
    ['ssh://admin@.host', /host name/],
    ['telnet://-l%20root@switch', /user name/],
    ['telnet://--help', /host name/],
  ])('rejects option or shell injection in %s', (url, message) => {
    expect(rejection(url)).toMatch(message);
  });

  it('rejects passwords in the link', () => {
    expect(rejection('ssh://admin:secret@host')).toMatch(/password/);
    expect(rejection('telnet://admin:@switch')).toMatch(/password/);
  });

  it('rejects other schemes', () => {
    for (const url of ['sftp://host', 'https://example.com', 'file:///etc/passwd', 'rlogin://host', 'host']) {
      expect(rejection(url)).toMatch(/only ssh:\/\/ and telnet:\/\//);
    }
  });

  it.each([
    'ssh:host',
    'ssh:/host',
    'ssh://host name',
    'ssh://ho\tst',
    'ssh://ho\nst',
    'ssh://us%ZZer@host',
    'ssh://us%C3er@host',
    'ssh://"host"',
  ])('rejects the malformed link %j', (url) => {
    expect(parseConnectionLink(url).ok).toBe(false);
  });

  it('rejects links without a host', () => {
    expect(rejection('ssh://')).toMatch(/host/);
    expect(rejection('ssh://admin@')).toMatch(/host/);
    expect(rejection('ssh://admin@:22')).toMatch(/host/);
    expect(rejection('ssh://[]')).toMatch(/host/);
  });

  it('rejects broken IPv6 literals and ports', () => {
    expect(rejection('ssh://[2001:db8::1')).toMatch(/host name/);
    expect(rejection('ssh://[not-ipv6]:22')).toMatch(/host name/);
    expect(rejection('ssh://2001:db8::1')).toMatch(/port/);
    expect(rejection('ssh://host:0')).toMatch(/port/);
    expect(rejection('ssh://host:65536')).toMatch(/port/);
    expect(rejection('ssh://host:22x')).toMatch(/port/);
    expect(rejection('ssh://host:-22')).toMatch(/port/);
  });

  it('rejects oversized links and parts', () => {
    expect(rejection(`ssh://${'a'.repeat(2050)}`)).toMatch(/longer than/);
    expect(rejection(`ssh://${'a'.repeat(254)}`)).toMatch(/host name/);
    expect(rejection(`ssh://${'u'.repeat(256)}@host`)).toMatch(/user name/);
  });

  it('shortens what it quotes back', () => {
    expect(rejection(`ssh://-${'x'.repeat(200)}`).length).toBeLessThan(120);
  });
});

describe('host key fingerprints', () => {
  it('normalizes the accepted forms', () => {
    expect(normalizeHostKeyFingerprint(SHA256)).toBe(SHA256);
    expect(normalizeHostKeyFingerprint(`sha256:${SHA256.slice(7)}=`)).toBe(SHA256);
    expect(normalizeHostKeyFingerprint('SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8')).toBe(SHA256);
    // URL-safe base64 maps back to the alphabet ssh-keygen prints.
    expect(normalizeHostKeyFingerprint('SHA256:ab-_defghijklmnopqrstuvwxyz0123456789ABCDEF')).toBe(
      'SHA256:ab+/defghijklmnopqrstuvwxyz0123456789ABCDEF',
    );
    expect(normalizeHostKeyFingerprint(`ssh-ed25519-${MD5_PAIRS.replaceAll(':', '-')}`)).toBe(
      `ssh-ed25519 MD5:${MD5_PAIRS}`,
    );
    expect(normalizeHostKeyFingerprint(`ecdsa-sha2-nistp256-${MD5_PAIRS.replaceAll(':', '-')}`)).toBe(
      `ecdsa-sha2-nistp256 MD5:${MD5_PAIRS}`,
    );
    // The canonical form reads back as itself.
    expect(normalizeHostKeyFingerprint(`SSH-RSA md5:${MD5_PAIRS.toUpperCase()}`)).toBe(
      `ssh-rsa MD5:${MD5_PAIRS}`,
    );
  });

  it('rejects anything else', () => {
    for (const value of [
      '',
      'SHA256:',
      `${SHA256}x`,
      'SHA1:abcdef',
      MD5_PAIRS,
      `MD5:${MD5_PAIRS}:00`,
      `ssh-rsa-${MD5_PAIRS}`,
      `ssh-rsa SHA256:${SHA256.slice(7)}`,
    ]) {
      expect(normalizeHostKeyFingerprint(value)).toBeUndefined();
    }
  });
});

describe('link helpers', () => {
  it('formats a quick-connect target', () => {
    expect(connectionLinkTarget(link('ssh://admin@10.0.0.1:2222'))).toBe('admin@10.0.0.1:2222');
    expect(connectionLinkTarget(link('ssh://[2001:db8::1]:830'))).toBe('[2001:db8::1]:830');
    expect(connectionLinkTarget(link('ssh://[2001:db8::1]'))).toBe('2001:db8::1');
    expect(connectionLinkTarget(link('ssh://host'))).toBe('host');
  });

  it('tells links from files and switches', () => {
    expect(looksLikeConnectionLink('ssh://host')).toBe(true);
    expect(looksLikeConnectionLink('TELNET:switch')).toBe(true);
    expect(looksLikeConnectionLink('https://example.com')).toBe(true);
    expect(looksLikeConnectionLink('/opt/Muxus/muxus')).toBe(false);
    expect(looksLikeConnectionLink('C:\\Program Files\\Muxus\\Muxus.exe')).toBe(false);
    expect(looksLikeConnectionLink('--host=edge')).toBe(false);
    expect(looksLikeConnectionLink('.')).toBe(false);
  });
});
