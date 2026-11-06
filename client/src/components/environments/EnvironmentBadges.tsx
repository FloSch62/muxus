import { memo, useMemo } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import { environmentBadges } from '../../environments.js';
import { useEnvironmentsStore } from '../../state/environments.js';
import { useUiStore } from '../../state/ui.js';
import { loadEnvironmentsPanel } from '../../lazy-features.js';
import { EnvironmentLogo } from './environment-icons.js';

/**
 * What a host runs, as one small mark at the end of its sidebar row: the logos
 * of its container runtimes, labs, Kubernetes contexts and VMs, overlapped so
 * the row keeps its width for the name. The counts are in the tooltip. A host
 * that runs none of them shows nothing, so the tree stays as it was. Clicking
 * the mark opens the host in the containers and VMs panel.
 */
export const EnvironmentBadges = memo(function EnvironmentBadges({ hostKey }: { hostKey: string }) {
  const environments = useEnvironmentsStore((state) => state.entries[hostKey]?.environments);
  const panel = useUiStore((state) => state.environmentsPanel);
  const setPanel = useUiStore((state) => state.setEnvironmentsPanel);
  const badges = useMemo(() => (environments ? environmentBadges(environments) : []), [environments]);
  if (badges.length === 0) return null;
  const open = panel !== false && panel.hostKey === hostKey;

  return (
    <Tooltip
      disableInteractive
      // Stays over the sidebar, clear of the host's hover card beside it.
      placement="bottom-end"
      title={
        <>
          {badges.map((badge) => (
            <Box key={badge.kind}>{badge.label}</Box>
          ))}
        </>
      }
    >
      <ButtonBase
        aria-label={`${badges.map((badge) => badge.label).join(', ')}. Show`}
        tabIndex={-1}
        onMouseEnter={() => void loadEnvironmentsPanel()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setPanel(open ? false : { hostKey });
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        sx={{
          flexShrink: 0,
          height: 18,
          px: 0.25,
          borderRadius: 0.75,
          bgcolor: open ? 'action.selected' : 'transparent',
          '&:hover': { bgcolor: 'action.hover' },
          '& > * + *': { ml: '-2px' },
        }}
      >
        {badges.map((badge) => (
          <EnvironmentLogo key={badge.kind} kind={badge.kind} size={12} />
        ))}
      </ButtonBase>
    </Tooltip>
  );
});
