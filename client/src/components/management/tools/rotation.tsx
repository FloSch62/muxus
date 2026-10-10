import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import UndoRoundedIcon from '@mui/icons-material/UndoRounded';
import type { GrpcJson, ManagementError } from '@muxus/shared';
import type { ManagementConnection } from '../../../management/session-client.js';
import type { WorkbenchStore } from '../../../management/workbench-store.js';
import { activeStream, ErrorAlert, setActiveStream } from './common.js';

/**
 * gNSI's rotate pattern, shared by authz, pathz, certz and credentialz: the
 * upload takes effect at once but stays provisional while the stream is
 * open. Test it, then finalize; closing the stream or losing the
 * connection makes the device roll back.
 */

export type RotationPhase = 'idle' | 'uploading' | 'pending' | 'finalizing' | 'done' | 'rolled-back' | 'failed';

export interface RotationState {
  phase: RotationPhase;
  version?: string;
  startedAt?: number;
  error?: ManagementError;
}

interface RotationOptions {
  method: string;
  /** The upload message (upload_request, certificates, credential, …). */
  upload: GrpcJson;
  /** Name of the finalize field in this service's request. */
  finalizeField: string;
  version: string;
}

/** A fresh version string for an upload; devices refuse to re-upload the same one. */
export function rotationVersion(): string {
  return `muxus-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}`;
}

export function startRotation(
  grpc: ManagementConnection,
  store: WorkbenchStore,
  key: string,
  options: RotationOptions,
  setRotation: (update: Partial<RotationState>) => void,
  getPhase: () => RotationPhase,
): void {
  activeStream(store, key)?.cancel();
  setRotation({ phase: 'uploading', version: options.version, startedAt: Date.now(), error: undefined });
  const stream = grpc.grpcStream(options.method, undefined, {
    messages: () => {
      if (getPhase() === 'uploading') setRotation({ phase: 'pending' });
    },
    end: (error) => {
      setActiveStream(store, key, undefined);
      const phase = getPhase();
      if (error && !error.cancelled) setRotation({ phase: 'failed', error });
      else if (phase === 'finalizing') setRotation({ phase: 'done' });
      else if (phase === 'pending' || phase === 'uploading') setRotation({ phase: 'rolled-back' });
    },
  });
  setActiveStream(store, key, {
    cancel: () => stream.cancel(),
    finalize: () => {
      stream.send({ [options.finalizeField]: {} });
      stream.closeSend();
    },
  });
  stream.send(options.upload);
}

export function finalizeRotation(store: WorkbenchStore, key: string, setRotation: (update: Partial<RotationState>) => void): void {
  const active = activeStream(store, key);
  if (!active?.finalize) return;
  setRotation({ phase: 'finalizing' });
  active.finalize();
}

export function rollBackRotation(store: WorkbenchStore, key: string): void {
  activeStream(store, key)?.cancel();
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return <>{seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`}</>;
}

/** Where a rotation stands, with Finalize and Roll back while it is provisional. */
export function RotationBar({
  rotation,
  what,
  plural = false,
  testHint,
  onFinalize,
  onRollBack,
  onDismiss,
}: {
  rotation: RotationState;
  what: string;
  /** `what` names several things: "are", not "is". */
  plural?: boolean;
  testHint: string;
  onFinalize: () => void;
  onRollBack: () => void;
  onDismiss: () => void;
}) {
  if (rotation.phase === 'idle') return null;
  if (rotation.phase === 'failed') {
    return <ErrorAlert error={rotation.error} onClose={onDismiss} />;
  }
  const pending = rotation.phase === 'pending' || rotation.phase === 'uploading' || rotation.phase === 'finalizing';
  const verb = plural ? 'are' : 'is';
  const tone = rotation.phase === 'done' ? 'success' : rotation.phase === 'rolled-back' ? 'info' : 'warning';
  return (
    <Box
      sx={(theme) => ({
        border: 1,
        borderColor: `${tone}.main`,
        borderRadius: 2,
        p: 1.5,
        mb: 2,
        bgcolor: alpha(theme.palette[tone].main, 0.08),
      })}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {rotation.phase === 'done' ? (
          <CheckCircleRoundedIcon sx={{ color: 'success.main' }} />
        ) : rotation.phase === 'rolled-back' ? (
          <UndoRoundedIcon sx={{ color: 'info.main' }} />
        ) : rotation.phase === 'uploading' || rotation.phase === 'finalizing' ? (
          <CircularProgress size={18} />
        ) : (
          <HourglassTopRoundedIcon sx={{ color: 'warning.main' }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 650 }}>
            {rotation.phase === 'uploading'
              ? `Uploading the ${what} …`
              : rotation.phase === 'pending'
                ? `The new ${what} ${verb} active, but not final`
                : rotation.phase === 'finalizing'
                  ? 'Finalizing …'
                  : rotation.phase === 'done'
                    ? `The new ${what} ${verb} final`
                    : `Rolled back: the previous ${what} ${verb} back in force`}
            {rotation.version ? (
              <Typography component="span" variant="caption" color="textSecondary" sx={{ ml: 1 }}>
                version {rotation.version}
              </Typography>
            ) : null}
          </Typography>
          {rotation.phase === 'pending' && (
            <Typography variant="caption" color="textSecondary">
              {testHint} Closing this tab or losing the connection rolls it back
              {rotation.startedAt ? (
                <>
                  {' '}
                  · pending <Elapsed since={rotation.startedAt} />
                </>
              ) : null}
              .
            </Typography>
          )}
        </Box>
        {pending ? (
          <>
            <Button size="small" color="inherit" onClick={onRollBack} disabled={rotation.phase === 'finalizing'}>
              Roll back
            </Button>
            <Button size="small" variant="contained" color="warning" onClick={onFinalize} disabled={rotation.phase !== 'pending'}>
              Finalize
            </Button>
          </>
        ) : (
          <Button size="small" color="inherit" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </Stack>
    </Box>
  );
}
