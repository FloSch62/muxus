#!/usr/bin/env node
/**
 * Rebuild the vendored host icon artwork in client/src/vendor/host-icons.
 *
 * A host can show an icon of the user's choosing instead of the one for its
 * connection kind. The drawings come from two icon sets, both as single
 * 24x24 paths, and are copied here rather than installed: an icon a user
 * picked is stored by its id, so the art behind an id must not change or
 * disappear because a dependency was upgraded. The output is committed; run
 * this only to add an icon or move a pin.
 *
 *   node client/scripts/build-host-icons.mjs
 *
 * Every id listed here must also be in client/src/host-icon-catalog.ts, which
 * names and groups the icons for the picker. A unit test holds the two
 * together.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIMPLE_ICONS = { name: 'simple-icons', version: '16.38.1' };
const MATERIAL_DESIGN_ICONS = { name: '@mdi/js', version: '7.4.47' };

/**
 * Muxus icon id → Simple Icons slug. Product and vendor marks. Most wide
 * wordmarks are left out, because they do not read at the 16px of a sidebar
 * row.
 */
const SIMPLE_ICON_LOGOS = {
  // Operating systems
  linux: 'linux',
  ubuntu: 'ubuntu',
  debian: 'debian',
  arch: 'archlinux',
  fedora: 'fedora',
  redhat: 'redhat',
  centos: 'centos',
  rocky: 'rockylinux',
  alma: 'almalinux',
  opensuse: 'opensuse',
  suse: 'suse',
  alpine: 'alpinelinux',
  nixos: 'nixos',
  gentoo: 'gentoo',
  manjaro: 'manjaro',
  mint: 'linuxmint',
  kali: 'kalilinux',
  popos: 'popos',
  void: 'voidlinux',
  endeavouros: 'endeavouros',
  cachyos: 'cachyos',
  slackware: 'slackware',
  raspberrypi: 'raspberrypi',
  macos: 'apple',
  freebsd: 'freebsd',
  android: 'android',
  // Platforms
  docker: 'docker',
  kubernetes: 'kubernetes',
  proxmox: 'proxmox',
  openstack: 'openstack',
  openshift: 'redhatopenshift',
  rancher: 'rancher',
  k3s: 'k3s',
  talos: 'talos',
  nutanix: 'nutanix',
  qemu: 'qemu',
  truenas: 'truenas',
  unraid: 'unraid',
  homeassistant: 'homeassistant',
  // Network
  cisco: 'cisco',
  mikrotik: 'mikrotik',
  ubiquiti: 'ubiquiti',
  fortinet: 'fortinet',
  paloalto: 'paloaltonetworks',
  huawei: 'huawei',
  tplink: 'tplink',
  openwrt: 'openwrt',
  pfsense: 'pfsense',
  opnsense: 'opnsense',
  tailscale: 'tailscale',
  wireguard: 'wireguard',
  // Cloud
  googlecloud: 'googlecloud',
  digitalocean: 'digitalocean',
  hetzner: 'hetzner',
  ovh: 'ovh',
  akamai: 'akamai',
  vultr: 'vultr',
  scaleway: 'scaleway',
  cloudflare: 'cloudflare',
};

/**
 * Simple Icons draws to the edges of the 24px box, where Material glyphs
 * keep a margin, so a mark is shown at 20px to sit level with them. These are
 * no more than about half as tall as they are wide: their width is all they
 * have, and they keep all of it.
 */
const WIDE_MARKS = new Set(['cisco', 'cloudflare', 'rancher', 'suse']);

/**
 * Wordmarks shown by one letter: Muxus icon id → Simple Icons slug and the
 * letter's place among the mark's outlines. Nokia's mark is the word alone,
 * which is a smudge at icon size; where there is no room for the word, Nokia
 * itself shows the N.
 */
const LETTER_MARKS = {
  nokia: { slug: 'nokia', outline: 3 },
};
/** The square Material gives a glyph inside the 24px box. */
const LETTER_BOX = { size: 18, margin: 3 };

/** Marks Simple Icons no longer carries, from Material Design Icons. */
const MATERIAL_LOGOS = {
  windows: 'mdiMicrosoftWindows',
  azure: 'mdiMicrosoftAzure',
  aws: 'mdiAws',
};

/** Generic drawings Google's Material Icons, which the app ships, has none for. */
const MATERIAL_GLYPHS = {
  database: 'mdiDatabaseOutline',
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const cache = join(repoRoot, 'node_modules', '.cache', 'host-icons');
const output = join(repoRoot, 'client', 'src', 'vendor', 'host-icons');

/** Unpack one pinned package from the registry and return its directory. */
function fetchPackage({ name, version }) {
  const directory = join(cache, `${name.replace('/', '-').replace('@', '')}-${version}`);
  const unpacked = join(directory, 'package');
  if (existsSync(join(unpacked, 'package.json'))) return unpacked;
  mkdirSync(directory, { recursive: true });
  const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], {
    cwd: directory,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['xzf', tarball], { cwd: directory });
  return unpacked;
}

function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function key(id) {
  return /^[a-z][a-z0-9]*$/.test(id) ? id : quote(id);
}

const simpleIcons = fetchPackage(SIMPLE_ICONS);
const materialDesignIcons = fetchPackage(MATERIAL_DESIGN_ICONS);
const material = createRequire(import.meta.url)(join(materialDesignIcons, 'commonjs', 'mdi.js'));

function simpleIconPath(slug) {
  const file = join(simpleIcons, 'icons', `${slug}.svg`);
  if (!existsSync(file)) throw new Error(`Simple Icons ${SIMPLE_ICONS.version} has no "${slug}".`);
  const svg = readFileSync(file, 'utf8');
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)];
  if (!svg.includes('viewBox="0 0 24 24"') || paths.length !== 1) {
    throw new Error(`Unexpected drawing for "${slug}": one path in a 24x24 box is assumed.`);
  }
  return paths[0][1];
}

/**
 * One straight-edged outline of a mark, scaled to fill LETTER_BOX. Anything
 * but the line commands is refused rather than drawn wrong.
 */
function letterPath(slug, outline) {
  const outlines = simpleIconPath(slug).match(/[Mm][^Mm]*/g) ?? [];
  const letter = outlines[outline];
  if (!letter?.startsWith('M') || /[^MmLlHhVvZz\d\s.,-]/.test(letter)) {
    throw new Error(`Outline ${outline} of "${slug}" is not a straight-edged shape of its own.`);
  }
  const points = [];
  let x = 0;
  let y = 0;
  for (const [, command, list] of letter.matchAll(/([MmLlHhVv])([^MmLlHhVvZz]*)/g)) {
    const numbers = (list.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    const relative = command === command.toLowerCase();
    const step = 'Hh'.includes(command) || 'Vv'.includes(command) ? 1 : 2;
    for (let index = 0; index + step <= numbers.length; index += step) {
      if ('Hh'.includes(command)) x = numbers[index] + (relative ? x : 0);
      else if ('Vv'.includes(command)) y = numbers[index] + (relative ? y : 0);
      else {
        x = numbers[index] + (relative ? x : 0);
        y = numbers[index + 1] + (relative ? y : 0);
      }
      points.push([x, y]);
    }
  }
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const scale = LETTER_BOX.size / Math.max(width, height);
  const left = LETTER_BOX.margin + (LETTER_BOX.size - width * scale) / 2 - Math.min(...xs) * scale;
  const top = LETTER_BOX.margin + (LETTER_BOX.size - height * scale) / 2 - Math.min(...ys) * scale;
  const place = (value) => Number(value.toFixed(3));
  return `M${points.map(([px, py]) => `${place(px * scale + left)} ${place(py * scale + top)}`).join('L')}Z`;
}

function materialPath(name) {
  const path = material[name];
  if (!path) throw new Error(`Material Design Icons ${MATERIAL_DESIGN_ICONS.version} has no ${name}.`);
  return path;
}

const header = (what) => `// Generated by client/scripts/build-host-icons.mjs; do not edit by hand.
// ${what}
`;

const logos = [
  ...Object.entries(SIMPLE_ICON_LOGOS).map(([id, slug]) => ({
    id,
    path: simpleIconPath(slug),
    inset: !WIDE_MARKS.has(id),
  })),
  ...Object.entries(LETTER_MARKS).map(([id, { slug, outline }]) => ({
    id,
    path: letterPath(slug, outline),
    inset: false,
  })),
  ...Object.entries(MATERIAL_LOGOS).map(([id, name]) => ({
    id,
    path: materialPath(name),
    inset: false,
  })),
].sort((a, b) => a.id.localeCompare(b.id));

mkdirSync(output, { recursive: true });

writeFileSync(
  join(output, 'logos.ts'),
  `${header('Product and vendor marks a host can show as its icon. Loaded on first use.')}
export interface HostIconLogo {
  /** One path in a 24x24 box. */
  path: string;
  /** Shown at 20px in the middle of the box, level with the Material glyphs around it. */
  inset?: true;
}

export const HOST_ICON_LOGOS: Readonly<Record<string, HostIconLogo>> = {
${logos
  .map(
    ({ id, path, inset }) =>
      `  ${key(id)}: { path: ${quote(path)}${inset ? ', inset: true' : ''} },`,
  )
  .join('\n')}
};
`,
);

writeFileSync(
  join(output, 'glyphs.ts'),
  `${header('Generic glyphs a host can show as its icon, each one path in a 24x24 box.')}
export const HOST_ICON_GLYPHS = {
${Object.entries(MATERIAL_GLYPHS)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, name]) => `  ${key(id)}: ${quote(materialPath(name))},`)
  .join('\n')}
} as const;
`,
);

copyFileSync(join(simpleIcons, 'LICENSE.md'), join(output, 'LICENSE-SIMPLE-ICONS.md'));
copyFileSync(join(materialDesignIcons, 'LICENSE'), join(output, 'LICENSE-MATERIAL-DESIGN-ICONS'));

writeFileSync(
  join(output, 'README.md'),
  `# Host icon artwork (vendored)

Built by \`client/scripts/build-host-icons.mjs\`; do not edit by hand.

- \`logos.ts\`: product and vendor marks, from
  [Simple Icons](https://simpleicons.org) ${SIMPLE_ICONS.version} (CC0-1.0), and the
  ${Object.keys(MATERIAL_LOGOS).length} it no longer carries (${Object.keys(MATERIAL_LOGOS).join(', ')}) from
  [Material Design Icons](https://pictogrammers.com/library/mdi/) ${MATERIAL_DESIGN_ICONS.version} (Apache-2.0).
- \`glyphs.ts\`: generic drawings from Material Design Icons ${MATERIAL_DESIGN_ICONS.version}.

${Object.keys(LETTER_MARKS).length === 1 ? 'One mark is' : 'Some marks are'} cut down to a single letter of the wordmark (${Object.keys(LETTER_MARKS).join(', ')}), because the
whole word does not read at icon size.

Both license texts are included. The marks are trademarks of their owners and
are shown only to say what a host runs.
`,
);

console.log(
  `Wrote ${logos.length} logos and ${Object.keys(MATERIAL_GLYPHS).length} glyphs to ${output}`,
);
