import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glibcRelease, glibcRequirements, unmetRequirements } from './verify-linux-glibc.mjs';

// Trimmed `readelf --version-info --dyn-syms --wide` output of a node-pty
// built on glibc 2.42.
const builtOnNewGlibc = `
Symbol table '.dynsym' contains 4 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
    28: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND cfsetispeed@GLIBC_2.42 (3)
    52: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND cfsetospeed@GLIBC_2.42 (3)
    55: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND openpty@GLIBC_2.34 (11)

Version needs section '.gnu.version_r' contains 2 entries:
 Addr: 0x0000000000001a38  Offset: 0x00001a38  Link: 4 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: 4
  0x0010:   Name: GLIBC_2.42  Flags: none  Version: 3
  0x0020:   Name: GLIBC_2.34  Flags: none  Version: 11
  0x0030:   Name: GLIBC_2.4  Flags: none  Version: 10
  0x0040:   Name: GLIBC_ABI_DT_RELR  Flags: none  Version: 9
  0x0050: Version: 1  File: libstdc++.so.6  Cnt: 1
  0x0060:   Name: GLIBCXX_3.4.99  Flags: none  Version: 7
`;

await test('reads the glibc versions a binary needs and the symbols behind them', () => {
  const requirements = glibcRequirements(builtOnNewGlibc);
  assert.deepEqual([...requirements.keys()], ['GLIBC_2.42', 'GLIBC_2.34', 'GLIBC_2.4', 'GLIBC_ABI_DT_RELR']);
  assert.deepEqual(requirements.get('GLIBC_2.42'), ['cfsetispeed', 'cfsetospeed']);
  assert.deepEqual(requirements.get('GLIBC_2.34'), ['openpty']);
});

await test('reports only what the oldest supported glibc lacks', () => {
  const requirements = glibcRequirements(builtOnNewGlibc);
  assert.deepEqual(unmetRequirements(requirements, '2.39'), ['GLIBC_2.42 (cfsetispeed, cfsetospeed)']);
  assert.deepEqual(unmetRequirements(requirements, '2.42'), []);
});

await test('orders versions by number, not as text', () => {
  const requirements = new Map([['GLIBC_2.4', []], ['GLIBC_2.9', []], ['GLIBC_2.2.5', []], ['GLIBC_2.39', []]]);
  assert.deepEqual(unmetRequirements(requirements, '2.39'), []);
  assert.deepEqual(unmetRequirements(requirements, '2.5'), ['GLIBC_2.9', 'GLIBC_2.39']);
});

await test('knows when a named requirement arrived and rejects ones it has never seen', () => {
  assert.equal(glibcRelease('GLIBC_ABI_DT_RELR'), '2.36');
  assert.deepEqual(unmetRequirements(new Map([['GLIBC_ABI_DT_RELR', []]]), '2.35'), ['GLIBC_ABI_DT_RELR']);
  assert.deepEqual(unmetRequirements(new Map([['GLIBC_ABI_FUTURE', []]]), '2.39'), [
    'GLIBC_ABI_FUTURE, a requirement this check does not know',
  ]);
});
