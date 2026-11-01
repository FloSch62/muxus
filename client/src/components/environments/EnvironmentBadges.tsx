import { memo, useMemo } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import { environmentBadges } from '../../environments.js';
import { useEnvironmentsStore } from '../../state/environments.js';
import { useUiStore } from '../../state/ui.js';
import { loadEnvironmentsPanel } from '../../lazy-features.js';
import { ENVIRONMENT_KINDS } from './environment-icons.js';

/**
 * What a host runs, as small counts at the end of its sidebar row: running
 * containers, labs, Kubernetes contexts, running VMs. A host that runs none of
 * them shows nothing, so the tree stays as it was. Clicking one opens the
 * host in the containers and VMs panel.
 */
export const EnvironmentBadges = memo(function EnvironmentBadges({ hostKey }: { hostKey: string }) {
  const environments = useEnvironmentsStore((state) => state.entries[hostKey]?.environments);
  const panel = useUiStore((state) => state.environmentsPanel);
  const setPanel = useUiStore((state) => state.setEnvironmentsPanel);
  const badges = useMemo(() => (environments ? environmentBadges(environments) : []), [environments]);
  if (badges.length === 0) return null;
  const open = panel !== false && panel.hostKey === hostKey;

  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
      {badges.map((badge) => {
        const { Icon, color } = ENVIRONMENT_KINDS[badge.kind];
        return (
          <Tooltip key={badge.kind} title={badge.label} disableInteractive>
            <ButtonBase
              aria-label={`${badge.label}. Show`}
              tabIndex={-1}
              onMouseEnter={() => void loadEnvironmentsPanel()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setPanel(open ? false : { hostKey });
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              sx={{
                height: 18,
                px: 0.5,
                gap: 0.25,
                borderRadius: 0.75,
                border: 1,
                borderColor: open ? color : 'divider',
                bgcolor: open ? color : 'transparent',
                color: open ? '#fff' : 'text.secondary',
                fontSize: 11,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                '&:hover': { borderColor: color },
              }}
            >
              <Icon sx={{ fontSize: 11, color: open ? '#fff' : color }} />
              {badge.count}
            </ButtonBase>
          </Tooltip>
        );
      })}
    </Box>
  );
});
