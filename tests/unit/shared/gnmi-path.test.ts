import { describe, expect, it } from 'vitest';
import {
  formatGnmiPath,
  GnmiPathError,
  gnmiPathIdentity,
  gnmiPathStartsWith,
  gnmiSchemaPath,
  joinGnmiPaths,
  normalizeGnmiPath,
  parseGnmiPath,
  splitPathOptions,
} from '@muxus/shared';

describe('gNMI path strings', () => {
  it('parses elements and keys, keeping slashes inside key values', () => {
    expect(parseGnmiPath('/interface[name=ethernet-1/1]/subinterface[index=0]/statistics')).toEqual({
      elems: [
        { name: 'interface', keys: { name: 'ethernet-1/1' } },
        { name: 'subinterface', keys: { index: '0' } },
        { name: 'statistics' },
      ],
    });
  });

  it('reads several keys, module prefixes and an origin', () => {
    expect(parseGnmiPath('openconfig:/srl_nokia-acl:acl/acl-filter[name=cpm][type=ipv4]')).toEqual({
      origin: 'openconfig',
      elems: [
        { name: 'srl_nokia-acl:acl' },
        { name: 'acl-filter', keys: { name: 'cpm', type: 'ipv4' } },
      ],
    });
  });

  it('treats a colon without a slash after it as part of the element name', () => {
    expect(parseGnmiPath('srl_nokia-interfaces:interface').elems).toEqual([{ name: 'srl_nokia-interfaces:interface' }]);
  });

  it('round-trips escaped brackets and backslashes in key values', () => {
    const path = { elems: [{ name: 'policy', keys: { name: 'a]b\\c' } }] };
    const text = formatGnmiPath(path);
    expect(text).toBe('/policy[name=a\\]b\\\\c]');
    expect(parseGnmiPath(text)).toEqual(path);
  });

  it('accepts the root, a missing leading slash and a trailing slash', () => {
    expect(parseGnmiPath('/')).toEqual({ elems: [] });
    expect(parseGnmiPath('')).toEqual({ elems: [] });
    expect(parseGnmiPath('system/name/')).toEqual({ elems: [{ name: 'system' }, { name: 'name' }] });
    expect(normalizeGnmiPath('system/name/')).toBe('/system/name');
  });

  it('reports malformed paths with a position', () => {
    expect(() => parseGnmiPath('/interface[name=x')).toThrow(GnmiPathError);
    expect(() => parseGnmiPath('/a//b')).toThrow(/Empty path element/);
    expect(() => parseGnmiPath('/interface[name]')).toThrow(/name=value/);
    try {
      parseGnmiPath('/a/b]');
    } catch (err) {
      expect((err as GnmiPathError).position).toBe(4);
    }
  });

  it('joins prefixes and compares paths regardless of module prefixes', () => {
    const joined = joinGnmiPaths(parseGnmiPath('/network-instance[name=default]'), parseGnmiPath('/protocols/bgp'));
    expect(formatGnmiPath(joined)).toBe('/network-instance[name=default]/protocols/bgp');
    expect(gnmiPathIdentity(parseGnmiPath('/srl_nokia-interfaces:interface[name=e1]'))).toBe('/interface[name=e1]');
    expect(gnmiSchemaPath(parseGnmiPath('/interface[name=e1]/subinterface[index=0]'))).toBe('/interface/subinterface');
    expect(
      gnmiPathStartsWith(parseGnmiPath('/srl_nokia-interfaces:interface[name=e1]/statistics'), parseGnmiPath('/interface[name=*]')),
    ).toBe(true);
    expect(gnmiPathStartsWith(parseGnmiPath('/interface[name=e2]'), parseGnmiPath('/interface[name=e1]'))).toBe(false);
  });

  it('splits a device’s list of valid elements out of its error message', () => {
    expect(
      splitPathOptions("Path not valid - unknown element 'nope'. Options are [system, tunnel, interface]"),
    ).toEqual({ bad: 'nope', options: ['system', 'tunnel', 'interface'] });
    expect(splitPathOptions('permission denied')).toEqual({ options: [] });
  });
});
