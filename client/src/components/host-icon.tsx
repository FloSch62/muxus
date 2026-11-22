import { useCallback, useEffect, useSyncExternalStore, type ComponentType } from 'react';
import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';
import { createSvgIcon } from '@mui/material/utils';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import CallSplitOutlinedIcon from '@mui/icons-material/CallSplitOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import DeveloperBoardOutlinedIcon from '@mui/icons-material/DeveloperBoardOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import LaptopOutlinedIcon from '@mui/icons-material/LaptopOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MailOutlinedIcon from '@mui/icons-material/MailOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import SettingsEthernetOutlinedIcon from '@mui/icons-material/SettingsEthernetOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import SmartphoneOutlinedIcon from '@mui/icons-material/SmartphoneOutlined';
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined';
import StarBorderOutlinedIcon from '@mui/icons-material/StarBorderOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import TvOutlinedIcon from '@mui/icons-material/TvOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import VpnLockOutlinedIcon from '@mui/icons-material/VpnLockOutlined';
import WifiOutlinedIcon from '@mui/icons-material/WifiOutlined';
import type { SavedHostProfile, SessionProfile, SshHostEntry } from '@muxus/shared';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import type { ManagedHost } from '../managed-hosts.js';
import { HOST_ICON_GLYPHS } from '../vendor/host-icons/glyphs.js';
import type { HostIconLogo } from '../vendor/host-icons/logos.js';
import { hostKindIcon } from './host-kind-icon.js';

type IconComponent = ComponentType<SvgIconProps>;
type HostKind = SavedHostProfile['kind'];

function glyph(id: keyof typeof HOST_ICON_GLYPHS, name: string): IconComponent {
  return createSvgIcon(<path d={HOST_ICON_GLYPHS[id]} />, name);
}

/**
 * The general icons of the catalog (host-icon-catalog.ts, which names them
 * for the picker). Small, and in the initial bundle like the kind icons.
 */
const GENERAL_ICONS = new Map<string, IconComponent>(
  Object.entries({
    server: DnsOutlinedIcon,
    database: glyph('database', 'HostDatabase'),
    storage: StorageOutlinedIcon,
    cloud: CloudOutlinedIcon,
    container: ViewInArOutlinedIcon,
    vm: LayersOutlinedIcon,
    cluster: HubOutlinedIcon,
    router: RouterOutlinedIcon,
    switch: SettingsEthernetOutlinedIcon,
    firewall: ShieldOutlinedIcon,
    'load-balancer': CallSplitOutlinedIcon,
    network: LanOutlinedIcon,
    wireless: WifiOutlinedIcon,
    vpn: VpnLockOutlinedIcon,
    bastion: KeyOutlinedIcon,
    secure: LockOutlinedIcon,
    desktop: DesktopWindowsOutlinedIcon,
    laptop: LaptopOutlinedIcon,
    phone: SmartphoneOutlinedIcon,
    terminal: TerminalOutlinedIcon,
    serial: UsbOutlinedIcon,
    web: PublicOutlinedIcon,
    board: DeveloperBoardOutlinedIcon,
    chip: MemoryOutlinedIcon,
    sensor: SensorsOutlinedIcon,
    camera: VideocamOutlinedIcon,
    printer: PrintOutlinedIcon,
    media: TvOutlinedIcon,
    game: SportsEsportsOutlinedIcon,
    mail: MailOutlinedIcon,
    backup: BackupOutlinedIcon,
    monitoring: MonitorHeartOutlinedIcon,
    code: CodeOutlinedIcon,
    lab: ScienceOutlinedIcon,
    home: HomeOutlinedIcon,
    star: StarBorderOutlinedIcon,
  }),
);

/** The ids drawn by a component here; every other catalog id is a logo. */
export const GENERAL_HOST_ICON_IDS: readonly string[] = [...GENERAL_ICONS.keys()];

/**
 * The logos are several times the path data of every other icon in the app
 * and many windows never draw one, so they arrive with the first host that
 * shows one. `unavailable` says the chunk could not be loaded, and the host
 * falls back to its kind icon.
 */
type LogoArt = Readonly<Record<string, HostIconLogo>>;
let logoArt: LogoArt | 'unavailable' | undefined;
let logoArtRequested = false;
const logoArtListeners = new Set<() => void>();

function requestLogoArt(): void {
  if (logoArtRequested) return;
  logoArtRequested = true;
  void import('../vendor/host-icons/logos.js')
    .then(
      (module) => {
        logoArt = module.HOST_ICON_LOGOS;
      },
      () => {
        logoArt = 'unavailable';
      },
    )
    .then(() => {
      for (const listener of logoArtListeners) listener();
    });
}

function subscribeLogoArt(listener: () => void): () => void {
  logoArtListeners.add(listener);
  return () => logoArtListeners.delete(listener);
}

function readLogoArt(): LogoArt | 'unavailable' | undefined {
  return logoArt;
}

/**
 * Most logos reach the edges of their 24px box, Material glyphs stop two
 * pixels short of them. Drawn at 20px in the middle, such a logo sits level
 * with the glyphs around it.
 */
const INSET_TRANSFORM = 'translate(2 2) scale(0.8333)';

function createLogoIcon(id: string, kind: HostKind): IconComponent {
  const Fallback = hostKindIcon(kind);
  function HostLogoIcon(props: SvgIconProps) {
    const art = useSyncExternalStore(subscribeLogoArt, readLogoArt);
    useEffect(requestLogoArt, []);
    const logo = art === 'unavailable' ? undefined : art?.[id];
    if (art && !logo) return <Fallback {...props} />;
    // Empty while the art is on its way: a blank beat reads better than the
    // kind icon turning into another one.
    return (
      <SvgIcon {...props}>
        {logo ? (
          <path d={logo.path} transform={logo.inset ? INSET_TRANSFORM : undefined} />
        ) : null}
      </SvgIcon>
    );
  }
  return HostLogoIcon;
}

const logoIcons = new Map<string, IconComponent>();

/**
 * The icon a host shows: the one chosen for it, or the icon of its connection
 * kind when none was chosen. An id that is not a general icon is taken for a
 * logo, and one this build has no art for shows the kind icon as well. The
 * same component comes back for the same arguments, so it is safe to render.
 */
export function hostIcon(icon: string | undefined, kind: HostKind): IconComponent {
  if (!icon) return hostKindIcon(kind);
  const general = GENERAL_ICONS.get(icon);
  if (general) return general;
  const key = `${kind} ${icon}`;
  let logo = logoIcons.get(key);
  if (!logo) {
    logo = createLogoIcon(icon, kind);
    logoIcons.set(key, logo);
  }
  return logo;
}

/** The icon of a listed host. */
export function managedHostIcon(host: ManagedHost): IconComponent {
  return hostIcon(host.entry.metadata?.icon, host.kind === 'ssh' ? 'ssh' : host.entry.kind);
}

type RemoteProfile = Exclude<SessionProfile, { kind: 'local' }>;

const NO_HOSTS: readonly SshHostEntry[] = [];
const NO_PROFILES: readonly SavedHostProfile[] = [];
let iconsByHostFor: { hosts: readonly SshHostEntry[]; profiles: readonly SavedHostProfile[] } | undefined;
let iconsByHost: ReadonlyMap<string, string> = new Map();

/**
 * The icon chosen for each listed host, by the key a session finds its host
 * with. Every tab strip and row asks with the same two lists, so the answer
 * is kept until one of them changes.
 */
function chosenHostIcons(
  hosts: readonly SshHostEntry[],
  profiles: readonly SavedHostProfile[],
): ReadonlyMap<string, string> {
  if (iconsByHostFor?.hosts === hosts && iconsByHostFor.profiles === profiles) return iconsByHost;
  const byHost = new Map<string, string>();
  for (const host of hosts) {
    const icon = host.metadata?.icon;
    if (!icon) continue;
    for (const alias of host.aliases) byHost.set(`ssh:${alias}`, icon);
  }
  for (const profile of profiles) {
    if (profile.metadata.icon) byHost.set(`profile:${profile.id}`, profile.metadata.icon);
  }
  iconsByHostFor = { hosts, profiles };
  iconsByHost = byHost;
  return byHost;
}

/**
 * The icon of the host a session was opened from, for tabs and session lists.
 * It is read from the host lists rather than copied onto the tab, so giving a
 * host another icon changes its open sessions too.
 */
export function useSessionHostIcon(): (profile: RemoteProfile) => IconComponent {
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  const chosen = chosenHostIcons(config?.hosts ?? NO_HOSTS, saved?.profiles ?? NO_PROFILES);
  return useCallback(
    (profile) => {
      let icon: string | undefined;
      if (profile.profileId) icon = chosen.get(`profile:${profile.profileId}`);
      else if (profile.kind === 'ssh' && profile.useConfig !== false) {
        icon = chosen.get(`ssh:${profile.target}`);
      }
      return hostIcon(icon, profile.kind);
    },
    [chosen],
  );
}
