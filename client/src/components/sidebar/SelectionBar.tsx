import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import {
  loadFolderDialog,
  loadHostBulkEditDialog,
  loadHostEditorDialog,
} from '../../lazy-features.js';

/**
 * Pinned under the host tree while hosts are selected: how many, the actions
 * that apply to all of them, and the way out. One host opens its own editor;
 * several open the bulk editor.
 */
export function SelectionBar({
  count,
  onEdit,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  onEdit: () => void;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const preload = () => void (count === 1 ? loadHostEditorDialog() : loadHostBulkEditDialog());
  const preloadFolderDialog = () => void loadFolderDialog();
  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{ alignItems: 'center', px: 1.25, py: 0.75, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography variant="body2" noWrap aria-live="polite" sx={{ flex: 1, minWidth: 0 }}>
        {count} selected
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
      <Tooltip title="Move to folder…">
        <IconButton
          size="small"
          aria-label={`Move ${count === 1 ? 'the selected host' : `${count} selected hosts`} to a folder`}
          onMouseEnter={preloadFolderDialog}
          onFocus={preloadFolderDialog}
          onClick={onMove}
        >
          <DriveFileMoveOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Delete">
        <IconButton
          size="small"
          aria-label={`Delete ${count === 1 ? 'the selected host' : `${count} selected hosts`}`}
          onClick={onDelete}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Clear selection (Esc)">
        <IconButton size="small" aria-label="Clear selection" onClick={onClear}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
