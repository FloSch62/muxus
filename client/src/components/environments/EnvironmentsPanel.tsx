import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import SearchIcon from '@mui/icons-material/Search';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import type { ContainerlabLab, EnvironmentAction } from '@muxus/shared';
import { runEnvironmentAction } from '../../api/environments.js';
import {
  discoverHost,
  environmentSource,
  LOCAL_ENVIRONMENT_HOST,
  refreshHost,
  releaseEnvironmentDials,
  setEnvironmentDialHandlers,
} from '../../environments.js';
import { confirmAction } from '../../state/dialogs.js';
import {
  LOCAL_ENVIRONMENT_KEY,
  useEnvironmentsStore,
  type HostEnvironmentsEntry,
} from '../../state/environments.js';
import { showToast } from '../../state/toast.js';
import { useUiStore } from '../../state/ui.js';
import { layout, statusTextColor } from '../../theme.js';
import { usePrefsStore } from '../../state/prefs.js';
import {
  DEFAULT_ENVIRONMENTS_PANEL_WIDTH,
  MIN_ENVIRONMENTS_PANEL_WIDTH,
  clampEnvironmentsPanelWidth,
  maxEnvironmentsPanelWidth,
} from '../../environments-panel-width.js';
import { PanelResizeHandle } from '../PanelResizeHandle.js';
import { AuthPromptDialog, type AuthPromptRequest, type AuthPromptResult } from '../AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from '../HostKeyDialog.js';
import { ClabTopologyDialog } from './ClabTopologyDialog.js';
import { ENVIRONMENT_KINDS } from './environment-icons.js';
import {
  ContainerlabSection,
  ContainersSection,
  LibvirtSection,
  ProxmoxSection,
  type SectionProps,
} from './EnvironmentSections.js';
import { LineAction, LineMenu, NoteLine, TreeLine, useExpansion, type Expansion } from './EnvironmentTree.js';
import { KubernetesSection } from './KubernetesSection.js';

const PROVIDER_LABELS = {
  docker: 'Docker',
  podman: 'Podman',
  kubernetes: 'Kubernetes',
  proxmox: 'Proxmox VE',
  libvirt: 'libvirt',
} as const;

function age(sampledAt: number | undefined, now: number): string | undefined {
  if (!sampledAt) return undefined;
  const seconds = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/**
 * The containers, clusters, labs and VMs of this computer and of SSH hosts,
 * as one tree per host the way XPipe's connection hub lays them out: host,
 * then each tool it has (Docker, Containerlab, Kubernetes, Proxmox, libvirt),
 * then what runs there, each line with its own actions. Opened for one host
 * from its sidebar badge or menu, or for all of them from the top bar.
 */
export function EnvironmentsPanel() {
  const panel = useUiStore((state) => state.environmentsPanel);
  const setPanel = useUiStore((state) => state.setEnvironmentsPanel);
  const entries = useEnvironmentsStore((state) => state.entries);
  const order = useEnvironmentsStore((state) => state.order);
  const scopeKey = panel ? panel.hostKey : undefined;
  const [filter, setFilter] = useState('');
  const [showStopped, setShowStopped] = useState(false);
  const [topology, setTopology] = useState<{ host: HostEnvironmentsEntry; lab: ContainerlabLab } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expansion = useExpansion();
  const panelRef = useRef<HTMLElement>(null);
  const panelWidth = usePrefsStore((state) => state.environmentsPanelWidth);
  const sidebarOnRight = usePrefsStore((state) => state.sidebarPosition === 'right');
  const setPrefs = usePrefsStore((state) => state.set);
  const [expanded, setExpanded] = useState(false);
  const [dialAuth, setDialAuth] = useState<{
    request: AuthPromptRequest;
    resolve: (result: AuthPromptResult | null) => void;
  } | null>(null);
  const [dialHostKey, setDialHostKey] = useState<{
    request: HostKeyRequest;
    resolve: (accept: boolean) => void;
  } | null>(null);

  // While the panel is open it answers the prompts of hosts it dials; closing
  // it lets go of those connections.
  useEffect(() => {
    setEnvironmentDialHandlers({
      onAuthPrompt: (request) => new Promise((resolve) => setDialAuth({ request, resolve })),
      onHostKey: (request) => new Promise((resolve) => setDialHostKey({ request, resolve })),
    });
    return () => {
      setEnvironmentDialHandlers(undefined);
      releaseEnvironmentDials();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // A host opened from the sidebar is read now if nothing is known about it yet;
  // the overview always includes this computer.
  const scoped = scopeKey ? entries[scopeKey] : undefined;
  useEffect(() => {
    const store = useEnvironmentsStore.getState();
    if (!scopeKey) {
      if (!store.entries[LOCAL_ENVIRONMENT_KEY]) {
        void discoverHost(LOCAL_ENVIRONMENT_HOST, { automatic: false, interactive: false });
      }
      return;
    }
    const entry = store.entries[scopeKey];
    if (entry && (entry.status === 'offline' || (entry.status !== 'loading' && entry.environments.length === 0))) {
      void discoverHost(entry, { automatic: false, interactive: true });
    }
  }, [scopeKey]);

  const hosts = useMemo(() => {
    if (scopeKey) return scoped ? [scoped] : [];
    return order
      .map((key) => entries[key])
      .filter(
        (entry): entry is HostEnvironmentsEntry =>
          !!entry &&
          // Hosts found on connect that run nothing listable stay out of the overview.
          (entry.key === LOCAL_ENVIRONMENT_KEY || !entry.automatic || entry.environments.length > 0),
      );
  }, [scopeKey, scoped, order, entries]);

  const act = async (
    host: HostEnvironmentsEntry,
    action: EnvironmentAction,
    confirm?: { title: string; description: string },
  ) => {
    if (confirm && !(await confirmAction({ ...confirm, confirmLabel: 'Continue', destructive: true }))) return;
    try {
      const source = await environmentSource(host, true);
      if (!source) throw new Error(`${host.label} is not connected`);
      const result = await runEnvironmentAction(source, action);
      if (!result.ok) showToast('error', result.output || 'The action failed.');
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : String(error));
    }
    void refreshHost(host);
  };

  const query = filter.trim().toLowerCase();

  return (
    <Box
      ref={panelRef}
      component="aside"
      aria-label="Containers and VMs"
      sx={{
        position: 'relative',
        // Expanded, it takes what the sidebar and a usable workspace leave.
        width: expanded ? 'calc(100% - 560px)' : panelWidth,
        minWidth: MIN_ENVIRONMENTS_PANEL_WIDTH,
        maxWidth: expanded ? '75%' : 'calc(100% - 560px)',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'sidebar',
        borderLeft: 1,
        borderRight: 1,
        borderColor: 'divider',
      }}
    >
      {/* As tall as the tab strip beside it, so their bottom lines meet. */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          height: layout.tabStripHeight,
          flexShrink: 0,
          boxSizing: 'border-box',
          px: 1.5,
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <ViewInArOutlinedIcon fontSize="small" color="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700, lineHeight: scoped ? 1.25 : undefined }}>
            {scoped ? scoped.label : 'Containers & VMs'}
          </Typography>
          {scoped ? (
            <Button
              size="small"
              onClick={() => setPanel({})}
              sx={{ p: 0, minWidth: 0, fontSize: 11, textTransform: 'none', lineHeight: 1.1, display: 'block' }}
            >
              All hosts
            </Button>
          ) : null}
        </Box>
        <Tooltip title={scoped ? `Read ${scoped.label} again` : 'Read every host again'}>
          <IconButton
            size="small"
            aria-label="Read again"
            onClick={() => {
              for (const host of hosts) void refreshHost(host);
            }}
          >
            <RefreshOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={expanded ? 'Back to the set width' : 'Widen to see more'}>
          <IconButton
            size="small"
            aria-label={expanded ? 'Restore panel width' : 'Widen panel'}
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <IconButton size="small" aria-label="Close containers and VMs panel" onClick={() => setPanel(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, alignItems: 'center' }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Filter by name, image or address"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter) {
              event.stopPropagation();
              setFilter('');
            }
          }}
          slotProps={{
            htmlInput: { 'aria-label': 'Filter containers and VMs' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              sx: { fontSize: 13 },
            },
          }}
        />
        <FormControlLabel
          control={<Switch size="small" checked={showStopped} onChange={(event) => setShowStopped(event.target.checked)} />}
          label="Stopped"
          slotProps={{ typography: { sx: { fontSize: 12, color: 'text.secondary' } } }}
          sx={{ mr: 0, flexShrink: 0 }}
        />
      </Stack>

      <Box role="tree" aria-label="Hosts and what they run" sx={{ flex: 1, overflowY: 'auto', pb: 2 }}>
        {hosts.length === 0 ? (
          <Typography variant="body2" color="textSecondary" sx={{ px: 1.5, py: 2 }}>
            Nothing found yet. Hosts appear here once Muxus connects to them and finds Docker, Podman,
            Containerlab, Kubernetes, Proxmox or libvirt. To look at a host now, right-click it in the
            sidebar and choose Containers &amp; VMs.
          </Typography>
        ) : null}
        {hosts.map((host) => (
          <HostCard
            key={host.key}
            host={host}
            scoped={!!scoped}
            filter={query}
            showStopped={showStopped}
            expansion={expansion}
            now={now}
            act={(action, confirm) => void act(host, action, confirm)}
            onTopology={(lab) => setTopology({ host, lab })}
            onForget={() => {
              useEnvironmentsStore.getState().remove(host.key);
              if (scoped) setPanel({});
            }}
          />
        ))}
      </Box>

      <AuthPromptDialog
        request={dialAuth?.request ?? null}
        onSubmit={(result) => {
          dialAuth?.resolve(result);
          setDialAuth(null);
        }}
      />
      <HostKeyDialog
        request={dialHostKey?.request ?? null}
        onAnswer={(accept) => {
          dialHostKey?.resolve(accept);
          setDialHostKey(null);
        }}
      />
      {topology ? (
        <ClabTopologyDialog
          host={entries[topology.host.key] ?? topology.host}
          lab={topology.lab}
          onClose={() => setTopology(null)}
        />
      ) : null}
      {expanded ? null : (
        <PanelResizeHandle
          panelRef={panelRef}
          // The panel sits between the sidebar and the panes: it grows toward the panes.
          edge={sidebarOnRight ? 'left' : 'right'}
          width={panelWidth}
          defaultWidth={DEFAULT_ENVIRONMENTS_PANEL_WIDTH}
          minWidth={MIN_ENVIRONMENTS_PANEL_WIDTH}
          maxWidth={maxEnvironmentsPanelWidth}
          clampWidth={clampEnvironmentsPanelWidth}
          onWidthChange={(environmentsPanelWidth) => setPrefs({ environmentsPanelWidth })}
          label="Resize containers and VMs panel"
        />
      )}
    </Box>
  );
}

function HostCard({
  host,
  scoped,
  filter,
  showStopped,
  expansion,
  now,
  act,
  onTopology,
  onForget,
}: {
  host: HostEnvironmentsEntry;
  scoped: boolean;
  filter: string;
  showStopped: boolean;
  expansion: Expansion;
  now: number;
  act: SectionProps['act'];
  onTopology: (lab: ContainerlabLab) => void;
  onForget: () => void;
}) {
  const key = `host:${host.key}`;
  const open = scoped || expansion.isOpen(key, true);
  const local = host.key === LOCAL_ENVIRONMENT_KEY;
  const HostIcon = local ? ComputerOutlinedIcon : DnsOutlinedIcon;
  const tools = host.environments
    .map((environment) =>
      environment.kind === 'containers'
        ? ENVIRONMENT_KINDS[environment.runtime].label
        : ENVIRONMENT_KINDS[environment.kind].label,
    )
    .filter((label, index, all) => all.indexOf(label) === index);
  const status =
    host.status === 'loading' ? (
      <CircularProgress size={12} sx={{ display: 'block' }} />
    ) : host.status === 'ready' ? (
      age(host.sampledAt, now)
    ) : host.status === 'offline' ? (
      'not connected'
    ) : host.status === 'unsupported' ? (
      'runs no commands'
    ) : (
      'failed'
    );
  const sectionProps: Omit<SectionProps, 'depth'> = { host, filter, showStopped, expansion, act };

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', py: 0.25 }}>
      <TreeLine
        depth={0}
        open={scoped ? undefined : open}
        onToggle={() => expansion.toggle(key, true)}
        icon={<HostIcon sx={{ fontSize: 17, color: host.color ?? 'text.secondary' }} />}
        title={host.label}
        detail={tools.join(' · ') || undefined}
        status={status}
        emphasis
        actions={
          <>
            <LineAction label={`Read ${host.label} again`} Icon={RefreshOutlinedIcon} onClick={() => void refreshHost(host)} />
            {local ? null : (
              <LineMenu label={`More actions for ${host.label}`} entries={[{ label: 'Remove from this list', onClick: onForget }]} />
            )}
          </>
        }
      />
      {open ? (
        <>
          {host.problems.map((problem) => (
            <Stack
              key={problem.provider}
              direction="row"
              spacing={0.75}
              sx={(theme) => ({
                pl: '30px',
                pr: 1,
                py: 0.25,
                alignItems: 'flex-start',
                fontSize: 11,
                color: statusTextColor('warning')(theme),
              })}
            >
              <WarningAmberOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
              <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {PROVIDER_LABELS[problem.provider]}: {problem.message}
              </Box>
            </Stack>
          ))}
          {host.status === 'offline' ? (
            <Stack direction="row" spacing={1} sx={{ pl: '30px', pr: 1, py: 0.5, alignItems: 'center' }}>
              <Typography variant="caption" color="textSecondary" sx={{ flex: 1 }}>
                {host.message ?? 'Not connected.'}
              </Typography>
              <Button size="small" onClick={() => void refreshHost(host)}>
                Connect
              </Button>
            </Stack>
          ) : null}
          {host.status === 'error' || host.status === 'unsupported' ? (
            <NoteLine depth={0} tone={host.status === 'error' ? 'error' : 'secondary'}>
              {host.message}
            </NoteLine>
          ) : null}
          {host.status === 'ready' && host.environments.length === 0 ? (
            <NoteLine depth={0}>
              No Docker, Podman, Kubernetes, Proxmox or libvirt found{local ? ' on this computer' : ''}.
            </NoteLine>
          ) : null}
          {host.environments.map((environment) => {
            switch (environment.kind) {
              case 'containers':
                return (
                  <ContainersSection key={environment.runtime} {...sectionProps} depth={1} environment={environment} />
                );
              case 'containerlab':
                return (
                  <ContainerlabSection
                    key="containerlab"
                    {...sectionProps}
                    depth={1}
                    environment={environment}
                    onTopology={onTopology}
                  />
                );
              case 'kubernetes':
                return <KubernetesSection key="kubernetes" {...sectionProps} depth={1} environment={environment} />;
              case 'proxmox':
                return <ProxmoxSection key="proxmox" {...sectionProps} depth={1} environment={environment} />;
              case 'libvirt':
                return <LibvirtSection key="libvirt" {...sectionProps} depth={1} environment={environment} />;
            }
          })}
        </>
      ) : null}
    </Box>
  );
}
