import { useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import { openLocalTerminal } from '../session-actions.js';
import { loadHostEditorDialog, loadTerminalViewImpl } from '../lazy-features.js';
import { HostPickerPopover } from './HostPickerPopover.js';

export function EmptyPane({
  onAddHost,
  replaceTabId,
}: {
  onAddHost: () => void;
  /** When rendered for a blank tab, the chosen session replaces that tab. */
  replaceTabId?: string;
}) {
  const [hostPickerAnchor, setHostPickerAnchor] = useState<HTMLElement | null>(null);

  return (
    <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', px: 2.5, py: 4 }} spacing={2.5}>
      <Box sx={{ textAlign: 'center' }}>
        <Typography variant="h6" sx={{ fontWeight: 650, mb: 0.5 }}>
          Start a session
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Open a shell here or connect to one of your SSH hosts.
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 1,
          width: 'min(100%, 570px)',
        }}
      >
        <EmptyAction
          icon={<TerminalIcon />}
          title="Local terminal"
          description="This device"
          primary
          onIntent={() => void loadTerminalViewImpl()}
          onClick={() => openLocalTerminal(replaceTabId)}
        />
        <EmptyAction
          icon={<DnsOutlinedIcon />}
          title="SSH host"
          description="Choose saved host"
          onIntent={() => void loadTerminalViewImpl()}
          onClick={(event) => setHostPickerAnchor(event.currentTarget)}
        />
        <EmptyAction
          icon={<AddIcon />}
          title="Add host"
          description="New SSH profile"
          onIntent={() => void loadHostEditorDialog()}
          onClick={onAddHost}
        />
      </Box>
      <HostPickerPopover
        anchorEl={hostPickerAnchor}
        onClose={() => setHostPickerAnchor(null)}
        replaceTabId={replaceTabId}
      />
    </Stack>
  );
}

function EmptyAction({
  icon,
  title,
  description,
  primary = false,
  onIntent,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  primary?: boolean;
  onIntent: () => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <ButtonBase
      onMouseEnter={onIntent}
      onFocus={onIntent}
      onClick={onClick}
      sx={{
        minHeight: 92,
        p: 1.5,
        display: 'flex',
        justifyContent: 'flex-start',
        textAlign: 'left',
        gap: 1.25,
        border: 1,
        borderColor: primary ? 'primary.main' : 'divider',
        borderRadius: 1.5,
        bgcolor: primary ? 'primary.main' : 'background.paper',
        color: primary ? 'primary.contrastText' : 'text.primary',
        transition: 'border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease',
        '&:hover': {
          transform: 'translateY(-1px)',
          borderColor: 'primary.main',
          boxShadow: 2,
        },
        '&:focus-visible': {
          outline: 2,
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      <Box
        sx={{
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          width: 34,
          height: 34,
          borderRadius: 1,
          bgcolor: primary ? 'rgba(255,255,255,0.16)' : 'action.hover',
          '& svg': { fontSize: 20 },
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {title}
        </Typography>
        <Typography
          variant="caption"
          sx={{ display: 'block', mt: 0.15, color: primary ? 'rgba(255,255,255,0.78)' : 'text.secondary' }}
        >
          {description}
        </Typography>
      </Box>
    </ButtonBase>
  );
}
