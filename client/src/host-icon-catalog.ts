import { matchesTokens, searchTokens } from './host-search.js';

export type HostIconSection = 'general' | 'os' | 'platform' | 'network' | 'cloud';

export interface HostIconEntry {
  /** Stored with the host, so an id never changes once it has shipped. */
  id: string;
  label: string;
  section: HostIconSection;
  /** Other words a search finds it by. */
  keywords?: string;
}

export const HOST_ICON_SECTIONS: ReadonlyArray<{ id: HostIconSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'os', label: 'Operating systems' },
  { id: 'platform', label: 'Platforms' },
  { id: 'network', label: 'Network' },
  { id: 'cloud', label: 'Cloud' },
];

/**
 * Every icon a host can be given, in the order the picker lists them. The
 * general ones are drawn like the rest of the app's icons; the others are the
 * marks of what a host runs, drawn in one color so a host's color tints them
 * the same way.
 */
export const HOST_ICONS: readonly HostIconEntry[] = [
  { id: 'server', label: 'Server', section: 'general', keywords: 'host machine' },
  { id: 'database', label: 'Database', section: 'general', keywords: 'db sql' },
  { id: 'storage', label: 'Storage', section: 'general', keywords: 'nas disk san' },
  { id: 'cloud', label: 'Cloud', section: 'general' },
  { id: 'container', label: 'Container', section: 'general' },
  { id: 'vm', label: 'Virtual machine', section: 'general', keywords: 'vm hypervisor' },
  { id: 'cluster', label: 'Cluster', section: 'general', keywords: 'node' },
  { id: 'router', label: 'Router', section: 'general', keywords: 'gateway' },
  { id: 'switch', label: 'Switch', section: 'general', keywords: 'ethernet' },
  { id: 'firewall', label: 'Firewall', section: 'general', keywords: 'security shield' },
  { id: 'load-balancer', label: 'Load balancer', section: 'general', keywords: 'proxy' },
  { id: 'network', label: 'Network', section: 'general', keywords: 'lan' },
  { id: 'wireless', label: 'Wireless', section: 'general', keywords: 'wifi access point' },
  { id: 'vpn', label: 'VPN', section: 'general', keywords: 'tunnel' },
  { id: 'bastion', label: 'Bastion', section: 'general', keywords: 'jump host key gateway' },
  { id: 'secure', label: 'Secure', section: 'general', keywords: 'lock' },
  { id: 'desktop', label: 'Desktop', section: 'general', keywords: 'workstation pc' },
  { id: 'laptop', label: 'Laptop', section: 'general', keywords: 'notebook' },
  { id: 'phone', label: 'Phone', section: 'general', keywords: 'mobile' },
  { id: 'terminal', label: 'Terminal', section: 'general', keywords: 'shell console' },
  { id: 'serial', label: 'Serial', section: 'general', keywords: 'usb console' },
  { id: 'web', label: 'Web', section: 'general', keywords: 'site internet' },
  { id: 'board', label: 'Board', section: 'general', keywords: 'embedded sbc' },
  { id: 'chip', label: 'Chip', section: 'general', keywords: 'cpu gpu embedded' },
  { id: 'sensor', label: 'Sensor', section: 'general', keywords: 'iot telemetry' },
  { id: 'camera', label: 'Camera', section: 'general', keywords: 'video' },
  { id: 'printer', label: 'Printer', section: 'general' },
  { id: 'media', label: 'Media', section: 'general', keywords: 'tv' },
  { id: 'game', label: 'Game server', section: 'general', keywords: 'gaming' },
  { id: 'mail', label: 'Mail', section: 'general', keywords: 'email' },
  { id: 'backup', label: 'Backup', section: 'general' },
  { id: 'monitoring', label: 'Monitoring', section: 'general', keywords: 'metrics health' },
  { id: 'code', label: 'Development', section: 'general', keywords: 'dev code build' },
  { id: 'lab', label: 'Lab', section: 'general', keywords: 'science test' },
  { id: 'home', label: 'Home', section: 'general', keywords: 'house' },
  { id: 'star', label: 'Star', section: 'general', keywords: 'favorite' },

  { id: 'linux', label: 'Linux', section: 'os', keywords: 'tux' },
  { id: 'windows', label: 'Windows', section: 'os', keywords: 'microsoft' },
  { id: 'macos', label: 'macOS', section: 'os', keywords: 'apple mac darwin' },
  { id: 'ubuntu', label: 'Ubuntu', section: 'os', keywords: 'linux' },
  { id: 'debian', label: 'Debian', section: 'os', keywords: 'linux' },
  { id: 'arch', label: 'Arch Linux', section: 'os' },
  { id: 'fedora', label: 'Fedora', section: 'os', keywords: 'linux' },
  { id: 'redhat', label: 'Red Hat', section: 'os', keywords: 'rhel linux' },
  { id: 'centos', label: 'CentOS', section: 'os', keywords: 'linux' },
  { id: 'rocky', label: 'Rocky Linux', section: 'os' },
  { id: 'alma', label: 'AlmaLinux', section: 'os' },
  { id: 'opensuse', label: 'openSUSE', section: 'os', keywords: 'linux' },
  { id: 'suse', label: 'SUSE', section: 'os', keywords: 'sles linux' },
  { id: 'alpine', label: 'Alpine Linux', section: 'os' },
  { id: 'nixos', label: 'NixOS', section: 'os', keywords: 'linux' },
  { id: 'gentoo', label: 'Gentoo', section: 'os', keywords: 'linux' },
  { id: 'manjaro', label: 'Manjaro', section: 'os', keywords: 'linux' },
  { id: 'mint', label: 'Linux Mint', section: 'os' },
  { id: 'kali', label: 'Kali Linux', section: 'os' },
  { id: 'popos', label: 'Pop!_OS', section: 'os', keywords: 'pop os system76 linux' },
  { id: 'void', label: 'Void Linux', section: 'os' },
  { id: 'endeavouros', label: 'EndeavourOS', section: 'os', keywords: 'linux' },
  { id: 'cachyos', label: 'CachyOS', section: 'os', keywords: 'linux' },
  { id: 'slackware', label: 'Slackware', section: 'os', keywords: 'linux' },
  { id: 'raspberrypi', label: 'Raspberry Pi', section: 'os', keywords: 'raspbian linux' },
  { id: 'freebsd', label: 'FreeBSD', section: 'os', keywords: 'bsd' },
  { id: 'android', label: 'Android', section: 'os' },

  { id: 'docker', label: 'Docker', section: 'platform', keywords: 'container' },
  { id: 'kubernetes', label: 'Kubernetes', section: 'platform', keywords: 'k8s' },
  { id: 'proxmox', label: 'Proxmox', section: 'platform', keywords: 'pve hypervisor' },
  { id: 'openstack', label: 'OpenStack', section: 'platform' },
  { id: 'openshift', label: 'OpenShift', section: 'platform', keywords: 'okd' },
  { id: 'rancher', label: 'Rancher', section: 'platform' },
  { id: 'k3s', label: 'K3s', section: 'platform', keywords: 'kubernetes' },
  { id: 'talos', label: 'Talos', section: 'platform', keywords: 'kubernetes' },
  { id: 'nutanix', label: 'Nutanix', section: 'platform', keywords: 'hypervisor' },
  { id: 'qemu', label: 'QEMU', section: 'platform', keywords: 'kvm hypervisor' },
  { id: 'truenas', label: 'TrueNAS', section: 'platform', keywords: 'freenas storage' },
  { id: 'unraid', label: 'Unraid', section: 'platform', keywords: 'nas storage' },
  { id: 'homeassistant', label: 'Home Assistant', section: 'platform', keywords: 'hass smart home' },

  { id: 'cisco', label: 'Cisco', section: 'network', keywords: 'ios nx-os' },
  { id: 'nokia', label: 'Nokia', section: 'network', keywords: 'sros srl' },
  { id: 'mikrotik', label: 'MikroTik', section: 'network', keywords: 'routeros' },
  { id: 'ubiquiti', label: 'Ubiquiti', section: 'network', keywords: 'unifi edgeos' },
  { id: 'fortinet', label: 'Fortinet', section: 'network', keywords: 'fortigate fortios' },
  { id: 'paloalto', label: 'Palo Alto Networks', section: 'network', keywords: 'pan-os' },
  { id: 'huawei', label: 'Huawei', section: 'network', keywords: 'vrp' },
  { id: 'tplink', label: 'TP-Link', section: 'network', keywords: 'omada' },
  { id: 'openwrt', label: 'OpenWrt', section: 'network' },
  { id: 'pfsense', label: 'pfSense', section: 'network', keywords: 'firewall' },
  { id: 'opnsense', label: 'OPNsense', section: 'network', keywords: 'firewall' },
  { id: 'tailscale', label: 'Tailscale', section: 'network', keywords: 'vpn' },
  { id: 'wireguard', label: 'WireGuard', section: 'network', keywords: 'vpn' },

  { id: 'aws', label: 'AWS', section: 'cloud', keywords: 'amazon ec2' },
  { id: 'azure', label: 'Azure', section: 'cloud', keywords: 'microsoft' },
  { id: 'googlecloud', label: 'Google Cloud', section: 'cloud', keywords: 'gcp' },
  { id: 'digitalocean', label: 'DigitalOcean', section: 'cloud', keywords: 'droplet' },
  { id: 'hetzner', label: 'Hetzner', section: 'cloud' },
  { id: 'ovh', label: 'OVHcloud', section: 'cloud' },
  { id: 'akamai', label: 'Akamai', section: 'cloud', keywords: 'linode' },
  { id: 'vultr', label: 'Vultr', section: 'cloud' },
  { id: 'scaleway', label: 'Scaleway', section: 'cloud' },
  { id: 'cloudflare', label: 'Cloudflare', section: 'cloud' },
];

const BY_ID = new Map(HOST_ICONS.map((entry) => [entry.id, entry]));

/** The catalog entry behind a stored icon id; none for an id this build does not know. */
export function hostIconEntry(id: string | undefined): HostIconEntry | undefined {
  return id ? BY_ID.get(id) : undefined;
}

const SEARCH_TEXT = new Map(
  HOST_ICONS.map((entry) => [
    entry.id,
    `${entry.label} ${entry.id} ${entry.keywords ?? ''}`.toLowerCase(),
  ]),
);

/** The icons a query finds, in catalog order; all of them for an empty query. */
export function searchHostIcons(query: string): readonly HostIconEntry[] {
  const tokens = searchTokens(query.trim().toLowerCase());
  if (tokens.length === 0) return HOST_ICONS;
  return HOST_ICONS.filter((entry) => matchesTokens(SEARCH_TEXT.get(entry.id) ?? '', tokens));
}
