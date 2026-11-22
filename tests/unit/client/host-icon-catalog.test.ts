import { describe, expect, it } from 'vitest';
import { GENERAL_HOST_ICON_IDS } from '../../../client/src/components/host-icon.js';
import {
  HOST_ICONS,
  HOST_ICON_SECTIONS,
  hostIconEntry,
  searchHostIcons,
} from '../../../client/src/host-icon-catalog.js';
import { HOST_ICON_GLYPHS } from '../../../client/src/vendor/host-icons/glyphs.js';
import { HOST_ICON_LOGOS } from '../../../client/src/vendor/host-icons/logos.js';

const ids = (section?: string) =>
  HOST_ICONS.filter((icon) => !section || icon.section === section).map((icon) => icon.id);

describe('host icon catalog', () => {
  it('lists every icon once, under an id the server accepts', () => {
    expect(new Set(ids()).size).toBe(HOST_ICONS.length);
    for (const id of ids()) expect(id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  it('files every icon in a section the picker shows', () => {
    const sections = new Set(HOST_ICON_SECTIONS.map((section) => section.id));
    for (const icon of HOST_ICONS) expect(sections.has(icon.section)).toBe(true);
  });

  it('has a drawing for every general icon, and no drawing nobody can pick', () => {
    expect([...GENERAL_HOST_ICON_IDS].sort()).toEqual(ids('general').sort());
  });

  it('has the vendored art for every logo, and no art nobody can pick', () => {
    const logos = HOST_ICONS.filter((icon) => icon.section !== 'general').map((icon) => icon.id);
    expect(Object.keys(HOST_ICON_LOGOS).sort()).toEqual(logos.sort());
  });

  it('draws each vendored path in the 24px box the icons share', () => {
    const paths = [
      ...Object.values(HOST_ICON_LOGOS).map((logo) => logo.path),
      ...Object.values(HOST_ICON_GLYPHS),
    ];
    for (const path of paths) expect(path).toMatch(/^[Mm][\d\s.,a-zA-Z-]+$/);
  });

  it('resolves a stored id, and nothing for one it does not know', () => {
    expect(hostIconEntry('ubuntu')?.label).toBe('Ubuntu');
    expect(hostIconEntry('not-an-icon')).toBeUndefined();
    expect(hostIconEntry(undefined)).toBeUndefined();
  });
});

describe('host icon search', () => {
  const found = (query: string) => searchHostIcons(query).map((icon) => icon.id);

  it('lists everything in catalog order for an empty query', () => {
    expect(searchHostIcons('')).toBe(HOST_ICONS);
    expect(searchHostIcons('   ')).toBe(HOST_ICONS);
  });

  it('matches the label, whatever the case', () => {
    expect(found('UBUN')).toEqual(['ubuntu']);
    expect(found('raspberry pi')).toEqual(['raspberrypi']);
  });

  it('finds an icon by the other names it goes by', () => {
    expect(found('k8s')).toEqual(['kubernetes']);
    expect(found('rhel')).toEqual(['redhat']);
    expect(found('nas')).toEqual(expect.arrayContaining(['storage', 'truenas', 'unraid']));
  });

  it('finds every Linux distribution under "linux"', () => {
    const linux = found('linux');
    expect(linux).toEqual(expect.arrayContaining(['linux', 'ubuntu', 'debian', 'arch', 'fedora', 'alpine']));
    expect(linux).not.toContain('windows');
    expect(linux).not.toContain('freebsd');
  });

  it('needs every word of the query', () => {
    expect(found('linux mint')).toEqual(['mint']);
    expect(found('linux windows')).toEqual([]);
  });
});
