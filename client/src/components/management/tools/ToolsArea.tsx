import type { ComponentType, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import NetworkPingIcon from '@mui/icons-material/NetworkPing';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import RouteOutlinedIcon from '@mui/icons-material/RouteOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import WorkspacePremiumOutlinedIcon from '@mui/icons-material/WorkspacePremiumOutlined';
import { useWorkbench, useWorkbenchState } from '../context.js';
import { AcctzTool } from './AcctzTool.js';
import { AuthzTool } from './AuthzTool.js';
import { CertzTool } from './CertzTool.js';
import { CredentialzTool } from './CredentialzTool.js';
import { FilesTool } from './FilesTool.js';
import { PathzTool } from './PathzTool.js';
import { PingTool } from './PingTool.js';
import { BgpTool, HealthTool, ProcessTool, RebootTool, SystemTool } from './SystemTools.js';
import { TracerouteTool } from './TracerouteTool.js';

interface ToolEntry {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  /** Any of these services makes the tool usable. */
  services: string[];
  component: ComponentType;
  danger?: boolean;
}

const OPERATIONS: ToolEntry[] = [
  { id: 'ping', label: 'Ping', hint: 'From the device, with live round-trip times', icon: <NetworkPingIcon />, services: ['gnoi.system.System'], component: PingTool },
  { id: 'traceroute', label: 'Traceroute', hint: 'The path from the device, hop by hop', icon: <RouteOutlinedIcon />, services: ['gnoi.system.System'], component: TracerouteTool },
  { id: 'files', label: 'Files', hint: 'Browse, preview, upload and download', icon: <FolderOpenOutlinedIcon />, services: ['gnoi.file.File'], component: FilesTool },
  { id: 'health', label: 'Health', hint: 'Component health and its evidence', icon: <HealthAndSafetyOutlinedIcon />, services: ['gnoi.healthz.Healthz'], component: HealthTool },
  { id: 'process', label: 'Processes', hint: 'Restart or stop a daemon', icon: <MemoryOutlinedIcon />, services: ['gnoi.system.System'], component: ProcessTool },
  { id: 'bgp', label: 'BGP', hint: 'Reset a neighbor, hard or soft', icon: <HubOutlinedIcon />, services: ['gnoi.bgp.BGP'], component: BgpTool },
  { id: 'system', label: 'System', hint: 'Clock and software image', icon: <AccessTimeIcon />, services: ['gnoi.system.System', 'gnoi.os.OS'], component: SystemTool },
  { id: 'reboot', label: 'Reboot', hint: 'Restart now or later, and watch it', icon: <RestartAltIcon />, services: ['gnoi.system.System'], component: RebootTool, danger: true },
];

const SECURITY: ToolEntry[] = [
  { id: 'authz', label: 'Authorization', hint: 'Who may call which RPC', icon: <AdminPanelSettingsOutlinedIcon />, services: ['gnsi.authz.v1.Authz'], component: AuthzTool },
  { id: 'pathz', label: 'Path authorization', hint: 'Who may read or write which path', icon: <RuleOutlinedIcon />, services: ['gnsi.pathz.v1.Pathz'], component: PathzTool },
  { id: 'certz', label: 'Certificates', hint: 'TLS profiles, certificates and trust', icon: <WorkspacePremiumOutlinedIcon />, services: ['gnsi.certz.v1.Certz'], component: CertzTool },
  { id: 'credentialz', label: 'SSH credentials', hint: 'Host keys and authorized keys', icon: <KeyOutlinedIcon />, services: ['gnsi.credentialz.v1.Credentialz'], component: CredentialzTool },
  { id: 'acctz', label: 'Accounting', hint: 'Who did what, as it happens', icon: <ReceiptLongOutlinedIcon />, services: ['gnsi.acctz.v1.AcctzStream', 'gnsi.acctz.v1.Acctz'], component: AcctzTool },
];

export function ToolsArea({ area, narrow }: { area: 'operations' | 'security'; narrow: boolean }) {
  const { controller, store, connected } = useWorkbench();
  const selected = useWorkbenchState((state) => state.tool[area]);
  const tools = area === 'operations' ? OPERATIONS : SECURITY;
  const offered = (tool: ToolEntry) => tool.services.some((service) => controller.hasService(service));
  const current = tools.find((tool) => tool.id === selected) ?? tools[0]!;
  const Tool = current.component;

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: narrow ? 'column' : 'row' }}>
      <Box
        component="nav"
        aria-label={area === 'operations' ? 'Operations' : 'Security'}
        sx={{
          ...(narrow
            ? { display: 'flex', overflowX: 'auto', borderBottom: 1, px: 0.5, py: 0.5, gap: 0.25, flexShrink: 0 }
            : { width: 232, flexShrink: 0, borderRight: 1, py: 1, px: 0.75, overflowY: 'auto' }),
          borderColor: 'divider',
          bgcolor: 'sidebar',
        }}
      >
        {!narrow && (
          <Typography
            variant="caption"
            sx={{ display: 'block', px: 1, pb: 0.75, fontWeight: 650, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10.5 }}
          >
            {area === 'operations' ? 'gNOI' : 'gNSI'}
          </Typography>
        )}
        {tools.map((tool) => {
          const available = offered(tool);
          const isSelected = tool.id === current.id;
          const button = (
            <Box
              component="button"
              type="button"
              key={tool.id}
              aria-current={isSelected ? 'page' : undefined}
              onClick={() => store.getState().setTool(area, tool.id)}
              sx={(theme) => ({
                all: 'unset',
                boxSizing: 'border-box',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                width: narrow ? 'auto' : '100%',
                flexShrink: 0,
                px: 1,
                py: narrow ? 0.5 : 0.75,
                mb: narrow ? 0 : 0.25,
                borderRadius: 1.5,
                color: available ? 'text.primary' : 'text.disabled',
                bgcolor: isSelected ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1) : 'transparent',
                '&:hover': { bgcolor: isSelected ? undefined : 'action.hover' },
                '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
                '& svg': {
                  fontSize: 18,
                  color: isSelected ? 'primary.main' : tool.danger && available ? 'error.main' : 'text.secondary',
                },
              })}
            >
              {tool.icon}
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 13, fontWeight: isSelected ? 650 : 500, lineHeight: 1.3 }} noWrap>
                  {tool.label}
                </Typography>
                {!narrow && (
                  <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.3 }} noWrap>
                    {available ? tool.hint : 'Not offered by this device'}
                  </Typography>
                )}
              </Box>
            </Box>
          );
          return narrow && !available ? (
            <Tooltip key={tool.id} title="Not offered by this device">
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        <Stack sx={{ maxWidth: 1080, mx: 'auto', px: narrow ? 1.5 : 3, py: narrow ? 1.5 : 2.5 }}>
          {!connected && (
            <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
              Connect to use the tools.
            </Typography>
          )}
          <Tool key={current.id} />
        </Stack>
      </Box>
    </Box>
  );
}
