import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { ForwardType } from '@muxus/shared';

/**
 * The "what does this tunnel actually do?" picture — a modern take on
 * MobaXterm's port-forwarding diagram. Three nodes, animated flow along the
 * connectors, the SSH-encrypted leg marked with a lock, and a plain-language
 * summary underneath. Renders live from the form values around it.
 */
export function ForwardDiagram({
  type,
  bindPort,
  targetHost,
  targetPort,
  serverLabel,
}: {
  type: ForwardType;
  bindPort?: string | number;
  targetHost?: string;
  targetPort?: string | number;
  serverLabel: string;
}) {
  const port = String(bindPort || '…');
  const target = `${targetHost || '…'}:${targetPort || '…'}`;
  const server = serverLabel || 'SSH server';

  const nodes: { icon: ReactNode; title: string; sub: string }[] =
    type === 'local'
      ? [
          { icon: <ComputerOutlinedIcon />, title: 'This computer', sub: `listens on 127.0.0.1:${port}` },
          { icon: <DnsOutlinedIcon />, title: server, sub: 'SSH server' },
          { icon: <LanguageOutlinedIcon />, title: target, sub: 'destination' },
        ]
      : type === 'remote'
        ? [
            { icon: <DnsOutlinedIcon />, title: server, sub: `listens on :${port}` },
            { icon: <ComputerOutlinedIcon />, title: 'This computer', sub: 'SSH client' },
            { icon: <LanguageOutlinedIcon />, title: target, sub: 'destination' },
          ]
        : [
            { icon: <ComputerOutlinedIcon />, title: 'This computer', sub: `SOCKS5 on 127.0.0.1:${port}` },
            { icon: <DnsOutlinedIcon />, title: server, sub: 'SSH server' },
            { icon: <LanguageOutlinedIcon />, title: 'Any destination', sub: 'chosen per request' },
          ];

  // In every layout the first leg is the SSH-encrypted one; the second is the
  // plain TCP hop the far end makes.
  const tunnelIndex = 0;
  const summary =
    type === 'local'
      ? `Apps connecting to 127.0.0.1:${port} on this computer reach ${target} through ${server}.`
      : type === 'remote'
        ? `Connections to port ${port} on ${server} reach ${target} from this computer.`
        : `Point apps at the SOCKS5 proxy 127.0.0.1:${port} to tunnel any destination through ${server}.`;

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'stretch' }}>
        {nodes.map((node, i) => (
          <Stack
            key={node.title + String(i)}
            direction="row"
            sx={{ flex: i < nodes.length - 1 ? '1 1 0' : '0 0 auto', minWidth: 0, alignItems: 'center' }}
          >
            <DiagramNode {...node} />
            {i < nodes.length - 1 && <Connector tunnel={i === tunnelIndex} />}
          </Stack>
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }}>
        {summary}
      </Typography>
    </Box>
  );
}

function DiagramNode({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <Stack spacing={0.5} sx={{ alignItems: 'center', width: 118, flexShrink: 0 }}>
      <Box
        sx={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'action.hover',
          border: 1,
          borderColor: 'divider',
          color: 'primary.main',
        }}
      >
        {icon}
      </Box>
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, fontSize: 12, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {title}
      </Typography>
      <Typography sx={{ fontSize: 10.5, color: 'text.secondary', fontFamily: '"JetBrains Mono", monospace', textAlign: 'center' }}>
        {sub}
      </Typography>
    </Stack>
  );
}

/** Animated dashed flow line; the encrypted leg carries a lock + SSH pill. */
function Connector({ tunnel }: { tunnel: boolean }) {
  return (
    <Box sx={{ flex: 1, minWidth: 24, position: 'relative', alignSelf: 'center', height: 30, mx: 0.5, mt: -3.5 }}>
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 2,
          color: tunnel ? 'primary.main' : 'text.disabled',
          background: 'repeating-linear-gradient(90deg, currentColor 0 6px, transparent 6px 12px)',
          animation: 'muxus-flow 0.7s linear infinite',
          '@keyframes muxus-flow': { to: { backgroundPosition: '12px 0' } },
        }}
      />
      {/* arrowhead */}
      <Box
        sx={{
          position: 'absolute',
          top: 'calc(50% - 3px)',
          right: -1,
          width: 0,
          height: 0,
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          borderLeft: '6px solid',
          borderLeftColor: tunnel ? 'primary.main' : 'text.disabled',
        }}
      />
      {tunnel && (
        <Stack
          direction="row"
          spacing={0.25}
          sx={{
            position: 'absolute',
            top: 'calc(50% - 17px)',
            left: '50%',
            transform: 'translateX(-50%)',
            alignItems: 'center',
            color: 'primary.main',
            bgcolor: 'background.paper',
            px: 0.5,
            borderRadius: 0.5,
          }}
        >
          <LockOutlinedIcon sx={{ fontSize: 11 }} />
          <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4 }}>SSH</Typography>
        </Stack>
      )}
    </Box>
  );
}
