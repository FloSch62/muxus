import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import TabOutlinedIcon from '@mui/icons-material/TabOutlined';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import type { ManagedHost } from '../../managed-hosts.js';
import { launchManagedHostGroup } from '../../session-actions.js';
import { showToast } from '../../state/toast.js';
import { useTabsStore, type SessionSetLayout } from '../../state/tabs.js';

/** The set of hosts a launch targets: one folder, one file group, or a subtree. */
export interface LaunchTarget {
  label: string;
  hosts: ManagedHost[];
}

const LAYOUTS: Array<{ value: SessionSetLayout; label: string; Icon: typeof TabOutlinedIcon }> = [
  { value: 'tabs', label: 'Tabs', Icon: TabOutlinedIcon },
  { value: 'columns', label: 'Columns', Icon: ViewColumnOutlinedIcon },
  { value: 'rows', label: 'Rows', Icon: TableRowsOutlinedIcon },
  { value: 'grid', label: 'Grid', Icon: GridViewOutlinedIcon },
];

export function LaunchGroupDialog({
  target,
  onClose,
}: {
  target: LaunchTarget | null;
  onClose: () => void;
}) {
  const tabs = useTabsStore((s) => s.tabs);
  const [layout, setLayout] = useState<SessionSetLayout>('tabs');

  // Every launch starts from the default layout rather than the last one used.
  const open = !!target;
  useEffect(() => {
    if (open) setLayout('tabs');
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Launch “{target?.label}”</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Start all {target?.hosts.length ?? 0} hosts and replace the current pane layout.
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={layout}
          onChange={(_event, value: SessionSetLayout | null) => {
            if (value) setLayout(value);
          }}
          aria-label="Host group layout"
        >
          {LAYOUTS.map(({ value, label, Icon }) => (
            <ToggleButton key={value} value={value} aria-label={label}>
              <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
                <Icon fontSize="small" />
                <Typography variant="caption">{label}</Typography>
              </Stack>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {tabs.some((tab) => tab.profile && tab.status !== 'closed') ? (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Existing live sessions will be closed when this group replaces the current layout.
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<PlayArrowOutlinedIcon />}
          disabled={!target?.hosts.length}
          onClick={() => {
            if (!target) return;
            const { hosts, label } = target;
            void launchManagedHostGroup(hosts, layout).then((ids) => {
              if (ids.length === 0) return;
              showToast(
                'success',
                `Launching ${ids.length} session${ids.length === 1 ? '' : 's'} from “${label}” in ${layout}.`,
              );
              onClose();
            });
          }}
        >
          Launch group
        </Button>
      </DialogActions>
    </Dialog>
  );
}
