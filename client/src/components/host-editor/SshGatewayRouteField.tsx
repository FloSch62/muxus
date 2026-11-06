import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import type { SshGateway } from '@muxus/shared';
import { MAX_JUMP_FALLBACKS } from '@muxus/shared/ws-protocol';
import { SshGatewayField } from './SshGatewayField.js';


/**
 * The SSH gateway a connection goes through, and the gateways to try in
 * order when it cannot be reached. Fallbacks only appear once a first
 * gateway is chosen; clearing it clears them too.
 */
export function SshGatewayRouteField({
  gateway,
  fallbacks,
  onChange,
  label = 'SSH gateway',
}: {
  gateway: SshGateway | undefined;
  fallbacks: readonly SshGateway[];
  onChange: (next: { sshGateway: SshGateway | undefined; sshGatewayFallbacks: SshGateway[] }) => void;
  label?: string;
}) {
  const list = [...fallbacks];
  const update = (next: SshGateway[]) => onChange({ sshGateway: gateway, sshGatewayFallbacks: next });
  // A fallback being picked is kept as a blank row until it has a host.
  return (
    <Stack spacing={1.5}>
      <SshGatewayField
        label={label}
        value={gateway}
        onChange={(sshGateway) =>
          onChange({ sshGateway, sshGatewayFallbacks: sshGateway ? list : [] })
        }
      />
      {gateway ? (
        <Stack spacing={1}>
          <Typography variant="caption" color="textSecondary">
            If {gateway.target} cannot be reached or cannot open the connection, Muxus tries these in order.
          </Typography>
          {list.map((fallback, i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Stack sx={{ flex: 1 }}>
                <SshGatewayField
                  label={`Then try (${i + 1})`}
                  value={fallback.target ? fallback : undefined}
                  onChange={(next) =>
                    update(next ? list.map((item, j) => (j === i ? next : item)) : list.filter((_, j) => j !== i))
                  }
                />
              </Stack>
              <IconButton
                size="small"
                aria-label={`Remove fallback ${fallback.target || i + 1}`}
                onClick={() => update(list.filter((_, j) => j !== i))}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
          {list.length < MAX_JUMP_FALLBACKS ? (
            <Stack direction="row">
              <Button
                size="small"
                startIcon={<AddIcon />}
                disabled={list.some((item) => !item.target)}
                onClick={() => update([...list, { target: '' }])}
              >
                Add fallback gateway
              </Button>
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** The fallbacks to save: picked ones only, never the primary again. */
export function savedGatewayFallbacks(
  gateway: SshGateway | undefined,
  fallbacks: readonly SshGateway[],
): SshGateway[] | undefined {
  if (!gateway) return undefined;
  const same = (a: SshGateway, b: SshGateway) =>
    a.profileId ? a.profileId === b.profileId : !b.profileId && a.target === b.target;
  const kept: SshGateway[] = [];
  for (const fallback of fallbacks) {
    if (!fallback.target || same(fallback, gateway) || kept.some((item) => same(item, fallback))) continue;
    kept.push(fallback);
  }
  return kept.length > 0 ? kept : undefined;
}
