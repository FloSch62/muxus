import { describe, expect, it } from 'vitest';
import { prepareCompareText, textsMatch, unifiedDiff } from '../../../client/src/text-compare.js';

const EXACT = { ignoreTimestamps: false, ignoreWhitespace: false };
const labels = { originalLabel: 'a', modifiedLabel: 'b' };
const numbered = (count: number) => Array.from({ length: count }, (_, index) => String(index + 1));

describe('prepareCompareText', () => {
  it('normalizes line endings and drops the trailing newlines', () => {
    expect(prepareCompareText('one\r\ntwo\rthree\n\n', EXACT)).toBe('one\ntwo\nthree');
  });

  it('drops leading timestamps only when asked', () => {
    const text = [
      '[2026-10-14T09:15:00.123Z] show bgp summary',
      '2026-10-14 09:15:00,250 sshd started',
      '2026/10/14T09:15:00+02:00 rebooted',
      '*Oct 14 09:15:00.123: %LINK-3-UPDOWN: Interface Gi0/1, changed state to up',
      'Oct  4 2026 09:15:00 r1 mgd[1]: commit',
      '09:15:00.5 ping ok',
      '2026-10-14 09:15:00,250:DEBUG:ncclient:connected',
      '10.0.0.1 via 10.0.0.2, 00:01:02',
      'interface Gi0/1',
    ].join('\n');
    expect(prepareCompareText(text, EXACT)).toBe(text);
    expect(prepareCompareText(text, { ...EXACT, ignoreTimestamps: true }).split('\n')).toEqual([
      'show bgp summary',
      'sshd started',
      'rebooted',
      '%LINK-3-UPDOWN: Interface Gi0/1, changed state to up',
      'r1 mgd[1]: commit',
      'ping ok',
      'DEBUG:ncclient:connected',
      '10.0.0.1 via 10.0.0.2, 00:01:02',
      'interface Gi0/1',
    ]);
  });

  it('keeps MAC and IPv6 addresses that start like a time', () => {
    const text = [
      '00:11:22:aa:bb:cc dev eth0 master br0',
      '00:11:22:AA:BB:CC dev eth1 master br0',
      '00:11:22:33:44:55 dev eth2 master br0',
      '2001:db8::1 dev eth0 metric 256',
      '10:20:30::1 via fe80::1 dev eth0',
    ].join('\n');
    expect(prepareCompareText(text, { ...EXACT, ignoreTimestamps: true })).toBe(text);
  });

  it('collapses inner whitespace and keeps the indentation', () => {
    expect(
      prepareCompareText('  Gi0/1\t  up     up  \n neighbor  10.0.0.2 ', { ...EXACT, ignoreWhitespace: true }),
    ).toBe('  Gi0/1 up up\n neighbor 10.0.0.2');
  });
});

describe('unifiedDiff', () => {
  it('is empty when the texts match', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb', labels)).toBe('');
    expect(unifiedDiff('', '', labels)).toBe('');
  });

  it('writes the hunks diff -u writes', () => {
    const pre = [
      'hostname r1',
      'interface Gi0/1',
      ' description uplink',
      ' ip address 10.0.0.1 255.255.255.0',
      ' no shutdown',
      'interface Gi0/2',
      ' shutdown',
      'router bgp 65000',
      ' neighbor 10.0.0.2 remote-as 65001',
      ' neighbor 10.0.0.3 remote-as 65002',
      'end',
    ].join('\n');
    const post = pre.replace(' neighbor 10.0.0.3 remote-as 65002', ' neighbor 10.0.0.4 remote-as 65004');
    expect(unifiedDiff(pre, post, { originalLabel: 'pre', modifiedLabel: 'post' })).toBe(
      [
        '--- pre',
        '+++ post',
        '@@ -7,5 +7,5 @@',
        '  shutdown',
        ' router bgp 65000',
        '  neighbor 10.0.0.2 remote-as 65001',
        '- neighbor 10.0.0.3 remote-as 65002',
        '+ neighbor 10.0.0.4 remote-as 65004',
        ' end',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff('', 'a\nb', labels)).toBe('--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  });

  it('splits changes more than twice the context apart into hunks', () => {
    const lines = numbered(20);
    const apart = lines.map((line) => (line === '2' ? 'two' : line === '10' ? 'ten' : line));
    expect(unifiedDiff(lines.join('\n'), apart.join('\n'), labels).split('\n').filter((line) => line.startsWith('@@'))).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -7,7 +7,7 @@',
    ]);
    const near = lines.map((line) => (line === '2' ? 'two' : line === '9' ? 'nine' : line));
    expect(unifiedDiff(lines.join('\n'), near.join('\n'), labels).split('\n').filter((line) => line.startsWith('@@'))).toEqual([
      '@@ -1,12 +1,12 @@',
    ]);
  });

  it('keeps lines that differ only in whitespace when asked, printing the original', () => {
    const before = 'interface Gi0/1\n shutdown\nend';
    const after = 'interface  Gi0/1 \n  shutdown\nexit';
    expect(unifiedDiff(before, after, { ...labels, ignoreWhitespace: true })).toBe(
      '--- a\n+++ b\n@@ -1,3 +1,3 @@\n interface Gi0/1\n  shutdown\n-end\n+exit\n',
    );
    expect(unifiedDiff(before, after, labels)).toContain('-interface Gi0/1\n- shutdown\n-end\n');
  });

  it('prints removed lines before added ones within a change', () => {
    expect(unifiedDiff('k\na\nb\nk\nc\nk', 'k\nx\ny\nk\nz\nk', labels)).toBe(
      '--- a\n+++ b\n@@ -1,6 +1,6 @@\n k\n-a\n-b\n+x\n+y\n k\n-c\n+z\n k\n',
    );
  });

  it('keeps common lines up to 2,000 changed lines and replaces the whole middle past that', () => {
    const middle = (prefix: string, count: number) => {
      const lines = numbered(count).map((line) => `${prefix}${line}`);
      return [...lines.slice(0, 500), 'keep', ...lines.slice(500)].join('\n');
    };
    expect(unifiedDiff(middle('a', 1_000), middle('b', 1_000), labels)).toContain('\n keep\n');
    const past = unifiedDiff(middle('a', 1_000), middle('b', 1_001), labels);
    expect(past).toContain('\n-keep\n');
    expect(past).toContain('\n+keep\n');
  });

  it('reports a very different middle as one replacement', () => {
    const before = numbered(2_500).map((line) => `a${line}`);
    const after = numbered(2_500).map((line) => `b${line}`);
    const diff = unifiedDiff(['head', ...before, 'tail'].join('\n'), ['head', ...after, 'tail'].join('\n'), labels).split('\n');
    expect(diff[2]).toBe('@@ -1,2502 +1,2502 @@');
    expect(diff.slice(4, 2_504).every((line) => line.startsWith('-a'))).toBe(true);
    expect(diff.slice(2_504, 5_004).every((line) => line.startsWith('+b'))).toBe(true);
  });
});

describe('textsMatch', () => {
  it('agrees with unifiedDiff on whether there is anything to report', () => {
    const cases: [string, string, boolean][] = [
      ['a\nb\n', 'a\nb', false],
      ['a\nb', 'a\nc', false],
      ['a\nb', 'a', false],
      ['  a\tb ', 'a b', true],
      ['  a\tb ', 'a b', false],
      ['', '', false],
    ];
    for (const [before, after, ignoreWhitespace] of cases) {
      expect(textsMatch(before, after, ignoreWhitespace)).toBe(
        unifiedDiff(before, after, { ...labels, ignoreWhitespace }) === '',
      );
    }
  });
});
