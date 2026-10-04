import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { loadHostBulkEditDialog, loadHostEditorDialog } from '../../lazy-features.js';

/**
 * Pinned under the host tree while hosts are selected: how many, the action
 * that applies to all of them, and the way out. One host opens its own
 * editor; several open the bulk editor.
 */
export function SelectionBar({
  count,
  onEdit,
  onClear,
}: {
  count: number;
  onEdit: () => void;
  onClear: () => void;
}) {
  const preload = () => void (count === 1 ? loadHostEditorDialog() : loadHostBulkEditDialog());
  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{ alignItems: 'center', px: 1.25, py: 0.75, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography variant="body2" noWrap aria-live="polite" sx={{ flex: 1, minWidth: 0 }}>
        {count} host{count === 1 ? '' : 's'} selected
      </Typography>
      <Button
        size="small"
        variant="contained"
        startIcon={<EditOutlinedIcon />}
        onMouseEnter={preload}
        onFocus={preload}
        onClick={onEdit}
      >
        Edit…
      </Button>
      <Tooltip title="Clear selection (Esc)">
        <IconButton size="small" aria-label="Clear selection" onClick={onClear}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
