import { useMemo } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SshGateway } from '@muxus/shared';
import { useSavedHostProfiles, useSshConfig } from '../../api/queries.js';
import { hostDisplayName } from '../../host-organization.js';
import { savedHostAddress, savedHostDisplayName } from '../../saved-hosts.js';

interface GatewayOption {
  key: string;
  label: string;
  detail: string;
  gateway: SshGateway;
}

/** Pick an SSH host (ssh_config or saved) that a connection is carried through. */
export function SshGatewayField({
  value,
  onChange,
  label = 'SSH gateway',
}: {
  value: SshGateway | undefined;
  onChange: (gateway: SshGateway | undefined) => void;
  label?: string;
}) {
  const { data: config } = useSshConfig();
  const { data: saved } = useSavedHostProfiles();
  const options = useMemo<GatewayOption[]>(() => {
    const fromConfig = (config?.hosts ?? []).map((host) => ({
      key: `ssh:${host.alias}`,
      label: hostDisplayName(host),
      detail: host.alias,
      gateway: { target: host.alias },
    }));
    const fromProfiles = (saved?.profiles ?? []).flatMap((profile) =>
      profile.profile.kind === 'ssh'
        ? [
            {
              key: `profile:${profile.id}`,
              label: savedHostDisplayName(profile),
              detail: savedHostAddress(profile),
              gateway: { target: profile.profile.target, profileId: profile.id },
            },
          ]
        : [],
    );
    return [...fromConfig, ...fromProfiles].sort((a, b) => a.label.localeCompare(b.label));
  }, [config?.hosts, saved?.profiles]);
  const selectedKey = value ? (value.profileId ? `profile:${value.profileId}` : `ssh:${value.target}`) : undefined;
  const selected =
    options.find((option) => option.key === selectedKey) ??
    (value ? { key: selectedKey!, label: value.target, detail: 'Not found', gateway: value } : null);

  return (
    <Autocomplete<GatewayOption>
      options={options}
      value={selected}
      isOptionEqualToValue={(option, candidate) => option.key === candidate.key}
      getOptionLabel={(option) => option.label}
      onChange={(_event, option) => onChange(option?.gateway)}
      renderOption={(props, option) => {
        const { key, ...optionProps } = props;
        return (
          <Box component="li" key={key} {...optionProps}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{option.label}</Typography>
              <Typography variant="caption" color="textSecondary" noWrap>
                {option.detail}
              </Typography>
            </Box>
          </Box>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} placeholder="Direct connection" />}
    />
  );
}
