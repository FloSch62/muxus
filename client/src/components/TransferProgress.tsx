import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, type SxProps, type Theme } from '@mui/material/styles';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import type { TransferProgressState } from '../transfer-progress.js';


export function formatSize(size?: number): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatSize(bytesPerSecond)}/s` : 'Starting…';
}

function transferLabel(transfer: TransferProgressState, host: string | undefined): string {
  const { name, direction, phase } = transfer;
  const onHost = host ? ` on ${host}` : ' on remote';
  if (phase === 'complete') {
    return direction === 'upload'
      ? `Uploaded ${name}${host ? ` to ${host}` : ''}`
      : `Downloaded ${name}`;
  }
  if (phase === 'cancelling') return `Cancelling ${name}…`;
  if (phase === 'finalizing') return `Finishing ${name}${onHost}…`;
  if (phase === 'preparing') return `Preparing ${name}…`;
  return direction === 'upload'
    ? `Uploading ${name}${host ? ` to ${host}` : ''}`
    : `Downloading ${name}`;
}

/** One transfer's name, progress bar, bytes and speed, with Cancel while it can still stop. */
export function TransferProgress({
  transfer,
  host,
  onCancel,
  sx,
}: {
  transfer: TransferProgressState;
  /** Names the remote end in the label ("to web-01") instead of "remote". */
  host?: string;
  onCancel?: () => void;
  sx?: SxProps<Theme>;
}) {
  const complete = transfer.phase === 'complete';
  const percent = complete
    ? 100
    : transfer.total && transfer.total > 0
      ? Math.min(100, (transfer.loaded / transfer.total) * 100)
      : undefined;
  const label = transferLabel(transfer, host);
  const Icon = transfer.direction === 'upload' ? UploadFileOutlinedIcon : DownloadOutlinedIcon;
  return (
    <Box
      sx={[
        (theme) => ({
          p: 1,
          border: 1,
          borderColor: complete ? alpha(theme.palette.success.main, 0.45) : 'divider',
          borderRadius: 1,
          bgcolor: complete
            ? alpha(theme.palette.success.main, 0.07)
            : alpha(theme.palette.primary.main, 0.04),
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, mb: 0.6 }}>
        <Icon color={complete ? 'success' : 'primary'} sx={{ fontSize: 17 }} />
        <Typography variant="caption" noWrap title={label} sx={{ flex: 1, fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="textSecondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {percent === undefined ? '—' : `${Math.round(percent)}%`}
        </Typography>
        {onCancel &&
          transfer.phase !== 'complete' &&
          transfer.phase !== 'finalizing' &&
          transfer.phase !== 'cancelling' && (
            <Button color="error" onClick={onCancel} sx={{ minWidth: 0, px: 0.75, py: 0.1 }}>
              Cancel
            </Button>
          )}
      </Stack>
      <LinearProgress
        color={complete ? 'success' : 'primary'}
        variant={percent === undefined ? 'indeterminate' : 'determinate'}
        value={percent ?? 0}
      />
      <Stack direction="row" sx={{ mt: 0.55, justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="textSecondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatSize(transfer.loaded)}
          {transfer.total !== undefined ? ` / ${formatSize(transfer.total)}` : ''}
          {transfer.phase === 'transferring' ? ` · ${formatSpeed(transfer.bytesPerSecond)}` : ''}
        </Typography>
        {(transfer.fileCount ?? 1) > 1 && (
          <Typography variant="caption" color="textSecondary">
            File {transfer.fileIndex} of {transfer.fileCount}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
