import { memo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { useQueryClient } from '@tanstack/react-query';
import { usePasswordVaultStatus } from '../api/password-vault-queries.js';
import { useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useUpdateSshMetadata } from '../api/ssh-config.js';
import { useActiveCommandButtonGroup } from '../command-button-groups.js';
import { commandButtonGroupOf, commandButtonLabel } from '../command-buttons.js';
import { usePrefsStore, type CommandBarPosition, type CommandButton } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { findVaultSecret, runCommandButton, vaultSecretMissing } from '../vault-secrets.js';
import { commandButtonColorSx } from './command-button-style.js';

export const ActionBar = memo(function ActionBar({
  position,
}: {
  position: CommandBarPosition;
}) {
  const buttons = usePrefsStore((state) => state.commandButtons);
  const showCommandBar = usePrefsStore((state) => state.showCommandBar);
  const setPrefs = usePrefsStore((state) => state.set);
  const activeTab = useTabsStore((state) => state.tabs.find((tab) => tab.id === state.activeId));
  const setOpen = useUiStore((state) => state.setCommandButtonsOpen);
  const { groups, shownId, host, hostName, hostGroupId, select } = useActiveCommandButtonGroup();
  const updateSshMetadata = useUpdateSshMetadata();
  const updateProfileMetadata = useUpdateHostProfileMetadata();
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [groupMenu, setGroupMenu] = useState<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  // Secret names and missing secrets need the vault; plain commands do not.
  const { data: vault } = usePasswordVaultStatus(
    buttons.some((button) => button.secretId !== undefined),
  );
  const grouped = groups.length > 1;
  if (!showCommandBar || (buttons.length === 0 && !grouped)) return null;
  const connected = activeTab?.status === 'connected';
  const atBottom = position === 'bottom';
  // Tooltips and menus open toward the panes rather than off the window edge.
  const tooltipPlacement = atBottom ? 'top' : 'bottom';
  const shownGroup = groups.find((group) => group.id === shownId);
  const shownButtons = buttons.filter(
    (button) => commandButtonGroupOf(button, groups) === shownId,
  );
  const countIn = (groupId: string) =>
    buttons.filter((button) => commandButtonGroupOf(button, groups) === groupId).length;
  // The same host setting as Terminal appearance → Command button group.
  const shownForHost = !!host && hostGroupId === shownId;
  const toggleHostGroup = () => {
    if (!host) return;
    const patch = { commandButtonGroup: shownForHost ? null : shownId };
    if (host.kind === 'ssh') updateSshMetadata.mutate({ alias: host.entry.alias, patch });
    else updateProfileMetadata.mutate({ id: host.entry.id, patch });
    showToast(
      'success',
      shownForHost
        ? `Sessions to ${hostName} no longer switch the command group.`
        : `Sessions to ${hostName} now show ${shownGroup?.name ?? 'this group'}.`,
    );
  };

  return (
    <Box
      aria-label="Saved command buttons"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ top: event.clientY, left: event.clientX });
      }}
      sx={{
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        bgcolor: 'sidebar',
        [atBottom ? 'borderTop' : 'borderBottom']: 1,
        borderColor: 'divider',
      }}
    >
      {grouped ? (
        <>
          <Tooltip
            placement={tooltipPlacement}
            title={
              hostName && shownId === hostGroupId
                ? `Command group · opened by ${hostName}`
                : 'Command group'
            }
          >
            <Button
              size="small"
              color="inherit"
              aria-label={`Command group: ${shownGroup?.name ?? ''}`}
              aria-haspopup="menu"
              aria-expanded={groupMenu ? 'true' : undefined}
              endIcon={<ExpandMoreIcon />}
              onClick={(event) => setGroupMenu(event.currentTarget)}
              sx={{
                flexShrink: 0,
                minWidth: 0,
                maxWidth: 200,
                px: 1,
                py: 0.25,
                color: 'sidebarInk',
                fontWeight: 550,
                '& .MuiButton-endIcon': { ml: 0.25 },
              }}
            >
              <Box
                component="span"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {shownGroup?.name}
              </Box>
            </Button>
          </Tooltip>
          <Divider orientation="vertical" flexItem sx={{ my: 1 }} />
        </>
      ) : null}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          overflowX: 'auto',
          scrollbarWidth: 'thin',
        }}
      >
        {shownButtons.length === 0 ? (
          <Typography variant="caption" color="textSecondary" noWrap sx={{ px: 0.5 }}>
            No commands in this group yet.
          </Typography>
        ) : null}
        {shownButtons.map((button) => {
          const secretButton = button.secretId !== undefined;
          const secret = button.secretId ? findVaultSecret(vault, button.secretId) : undefined;
          const missing = !!button.secretId && vaultSecretMissing(vault, button.secretId) === true;
          return (
            <Tooltip
              key={button.id}
              placement={tooltipPlacement}
              title={buttonTooltip(button, secret?.name, missing)}
            >
              <span style={{ flexShrink: 0 }}>
                <Button
                  size="small"
                  variant="outlined"
                  data-muxus-secret={secretButton ? (missing ? 'missing' : 'saved') : undefined}
                  disabled={!connected || (secretButton ? !button.secretId || missing : !button.command)}
                  startIcon={
                    !secretButton ? undefined : missing ? (
                      <WarningAmberOutlinedIcon aria-label="Secret missing" />
                    ) : (
                      <KeyOutlinedIcon aria-label="Sends a secret" />
                    )
                  }
                  onClick={() => {
                    const sent = runCommandButton(activeTab?.id, button, {
                      secretName: secret?.name,
                      queryClient,
                    });
                    if (!sent) showToast('warning', 'The active terminal is not connected.');
                  }}
                  sx={[
                    {
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      py: 0.25,
                      '& .MuiButton-startIcon': { mr: 0.5, '& svg': { fontSize: 16 } },
                    },
                    commandButtonColorSx(button.color),
                    missing ? { borderStyle: 'dashed' } : {},
                  ]}
                >
                  {commandButtonLabel(button)}
                </Button>
              </span>
            </Tooltip>
          );
        })}
      </Box>
      <Tooltip title="Manage command buttons" placement={tooltipPlacement}>
        <IconButton
          size="small"
          aria-label="Manage command buttons"
          onClick={() => setOpen(true)}
          sx={{ flexShrink: 0 }}
        >
          <SettingsOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        open={!!groupMenu}
        anchorEl={groupMenu}
        onClose={() => setGroupMenu(null)}
        anchorOrigin={{ vertical: atBottom ? 'top' : 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: atBottom ? 'bottom' : 'top', horizontal: 'left' }}
        slotProps={{
          list: { dense: true, 'aria-label': 'Command groups' },
          paper: { sx: { minWidth: 220, maxWidth: 320 } },
        }}
      >
        {groups.map((group) => (
          <MenuItem
            key={group.id}
            onClick={() => {
              setGroupMenu(null);
              select(group.id);
            }}
          >
            <ListItemText
              primary={group.name}
              secondary={group.id === hostGroupId && hostName ? `Opens with ${hostName}` : undefined}
              slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
            />
            <Typography
              variant="caption"
              color="textSecondary"
              aria-label={`${countIn(group.id)} commands`}
              sx={{ ml: 2, minWidth: 16, textAlign: 'right' }}
            >
              {countIn(group.id)}
            </Typography>
            {/* A fixed slot, so the counts line up whichever group is checked. */}
            <Box component="span" sx={{ width: 18, ml: 1, display: 'flex', flexShrink: 0 }}>
              {group.id === shownId ? (
                <CheckIcon aria-label="Shown group" sx={{ fontSize: 18 }} />
              ) : null}
            </Box>
          </MenuItem>
        ))}
        <Divider />
        {host ? (
          <MenuItem
            aria-checked={shownForHost}
            role="menuitemcheckbox"
            onClick={() => {
              setGroupMenu(null);
              toggleHostGroup();
            }}
            sx={{ whiteSpace: 'normal' }}
          >
            <ListItemIcon>
              {shownForHost ? (
                <CheckBoxIcon fontSize="small" color="primary" />
              ) : (
                <CheckBoxOutlineBlankIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText primary={`Always show ${shownGroup?.name ?? 'this group'} for ${hostName}`} />
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            setGroupMenu(null);
            setOpen(true);
          }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Manage command buttons…
        </MenuItem>
      </Menu>
      <Menu
        open={!!menu}
        anchorReference="anchorPosition"
        anchorPosition={menu ?? undefined}
        onClose={() => setMenu(null)}
      >
        <MenuItem
          onClick={() => {
            setMenu(null);
            setPrefs({ commandBarPosition: atBottom ? 'top' : 'bottom' });
          }}
        >
          <ListItemIcon>
            {atBottom ? (
              <VerticalAlignTopIcon fontSize="small" />
            ) : (
              <VerticalAlignBottomIcon fontSize="small" />
            )}
          </ListItemIcon>
          {atBottom ? 'Move bar to the top' : 'Move bar to the bottom'}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            setOpen(true);
          }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Manage command buttons…
        </MenuItem>
      </Menu>
    </Box>
  );
});

/** What a bar button does, in its tooltip. A secret button names its secret, never its value. */
function buttonTooltip(button: CommandButton, secretName: string | undefined, missing: boolean): string {
  if (button.secretId === undefined) {
    return `${button.command || 'No command'}${button.sendEnter ? ' · runs immediately' : ' · inserts only'}`;
  }
  if (missing) return 'Its secret was deleted from the password vault';
  if (!button.secretId) return 'No secret chosen';
  if (!secretName) return 'Types a secret from the password vault';
  return `Types the secret “${secretName}”${button.sendEnter ? ' and presses Enter' : ''}`;
}
