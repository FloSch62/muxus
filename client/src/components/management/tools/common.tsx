import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import type { AutocompleteRenderInputParams } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField, { type TextFieldProps } from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ManagementError } from '@muxus/shared';
import { useStore } from 'zustand';
import { defaultGnmiDraft } from '../../../management/requests.js';
import { ManagementRequestError, type ManagementConnection } from '../../../management/session-client.js';
import { useWorkbench } from '../context.js';
import { MONO_FONT } from '../PathText.js';

/** A tool's state in the workbench store, so it survives switching tools and reconnects. */
export function useToolState<T>(key: string, initial: () => T): [T, (update: Partial<T> | ((current: T) => T)) => void] {
  const { store } = useWorkbench();
  const stored = useStore(store, (state) => state.tools[key]) as T | undefined;
  const value = stored ?? initial();
  const set = useCallback(
    (update: Partial<T> | ((current: T) => T)) =>
      store.getState().setToolState(key, (current) => {
        const base = (current as T | undefined) ?? initial();
        return typeof update === 'function' ? update(base) : { ...base, ...update };
      }),
    // `initial` is a constant factory per tool.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key],
  );
  return [value, set];
}

/** The live connection for gNOI/gNSI calls, or null while disconnected. */
export function useGrpc(): ManagementConnection | null {
  const { controller, connected } = useWorkbench();
  return connected ? controller.connectionForTools : null;
}

export function errorOf(err: unknown): ManagementError {
  if (err instanceof ManagementRequestError) return err.error;
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Nanoseconds as milliseconds, with two decimals below 10 ms. */
export function nanosToMs(value: unknown): string {
  const nanos = Number(value ?? 0);
  const ms = nanos / 1e6;
  return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0);
}

/** Unix nanoseconds (as gNOI sends them) or seconds as a local date and time. */
export function deviceTime(value: unknown, unit: 'ns' | 's' = 'ns'): string {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return '—';
  let ms: number;
  try {
    const digits = typeof value === 'bigint' || typeof value === 'number' ? value.toString() : typeof value === 'string' ? value : '';
    ms = unit === 'ns' ? Number(BigInt(digits) / 1_000_000n) : Number(digits) * 1000;
  } catch {
    return String(value as string);
  }
  return new Date(ms).toLocaleString();
}

export function ToolHeader({
  icon,
  title,
  service,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  service: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', mb: 2 }}>
      <Box
        sx={(theme) => ({
          width: 36,
          height: 36,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          color: 'primary.main',
          bgcolor: theme.palette.mode === 'dark' ? 'rgba(110,139,251,0.14)' : 'rgba(59,102,245,0.1)',
        })}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" sx={{ lineHeight: 1.3 }}>
            {title}
          </Typography>
          <Chip size="small" label={service} variant="outlined" sx={{ height: 20, fontFamily: MONO_FONT, fontSize: 10.5 }} />
        </Stack>
        <Typography variant="body2" color="textSecondary" sx={{ mt: 0.25 }}>
          {description}
        </Typography>
      </Box>
      {actions}
    </Stack>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper', mb: 2 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, px: 1.75, py: 0.5, minHeight: 40, borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="subtitle2" sx={{ flex: '1 0 auto' }}>
          {title}
        </Typography>
        {actions}
      </Stack>
      <Box sx={{ p: 1.75 }}>{children}</Box>
    </Box>
  );
}

export function ErrorAlert({ error, onClose }: { error?: ManagementError; onClose?: () => void }) {
  if (!error) return null;
  return (
    <Alert severity={error.cancelled ? 'info' : 'error'} variant="outlined" onClose={onClose} sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {error.code && <Chip size="small" label={error.code} sx={{ height: 20, fontFamily: MONO_FONT, fontSize: 11 }} />}
        <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12.5, wordBreak: 'break-word' }}>
          {error.message}
        </Typography>
      </Stack>
    </Alert>
  );
}

/** A small statistic: big value, small label. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'success' | 'error' | 'warning' }) {
  return (
    <Box sx={{ minWidth: 88 }}>
      <Typography variant="caption" color="textSecondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5, fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography
        sx={{
          fontFamily: MONO_FONT,
          fontSize: 18,
          fontWeight: 600,
          color: tone ? `${tone}.main` : 'text.primary',
          lineHeight: 1.3,
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Confirmation for disruptive operations (reboot, killing a process): the
 * user types the device name, so a stray click or Enter cannot do it.
 */
export function TypedConfirmDialog({
  open,
  title,
  description,
  expected,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  expected: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expected;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      slotProps={{ transition: { onExited: () => setTyped('') } }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2">{description}</Typography>
          <TextField
            fullWidth
            label={`Type ${expected} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches) {
                event.preventDefault();
                onConfirm();
              }
            }}
            slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="error" disabled={!matches} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** gNMI path text → gnoi.types.Path JSON (origin and keyed elements). */
export function gnoiPath(elems: Array<{ name: string; keys?: Record<string, string> }>, origin?: string) {
  return {
    ...(origin ? { origin } : {}),
    elem: elems.map((elem) => ({ name: elem.name, ...(elem.keys ? { key: elem.keys } : {}) })),
  };
}

/**
 * Streams that outlive the tool view that started them (switching tools
 * keeps a ping running), keyed by workbench and tool.
 */
export interface ActiveStream {
  cancel: () => void;
  /** Rotations: send the finalize message and close our side. */
  finalize?: () => void;
}

const activeStreams = new WeakMap<object, Map<string, ActiveStream>>();

export function setActiveStream(store: object, key: string, stream: ActiveStream | undefined): void {
  let streams = activeStreams.get(store);
  if (!streams) {
    streams = new Map();
    activeStreams.set(store, streams);
  }
  if (stream) streams.set(key, stream);
  else streams.delete(key);
}

export function activeStream(store: object, key: string): ActiveStream | undefined {
  return activeStreams.get(store)?.get(key);
}

/**
 * Network instance (VRF) names, read once over gNMI from SR Linux's or
 * OpenConfig's model, for the tools that run inside one.
 */
export function useNetworkInstances(): string[] {
  const { controller, connected } = useWorkbench();
  const [state, setState] = useToolState<{ names: string[]; loaded: boolean }>('network-instances', () => ({
    names: [],
    loaded: false,
  }));
  const loaded = state.loaded;
  useEffect(() => {
    if (!connected || loaded) return;
    setState({ loaded: true });
    void (async () => {
      for (const path of ['/network-instance[name=*]/name', '/network-instances/network-instance[name=*]/name']) {
        try {
          const result = await controller.request({ ...defaultGnmiDraft(), paths: [path], dataType: 'config' });
          if (result.op !== 'gnmi-get') continue;
          const names = new Set<string>();
          const collect = (value: unknown): void => {
            if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === 'object') {
              for (const [key, child] of Object.entries(value)) {
                if (key.replace(/^.*:/, '') === 'name' && typeof child === 'string') names.add(child);
                else collect(child);
              }
            }
          };
          for (const notification of result.notifications) {
            for (const update of notification.updates) {
              const match = /\[name=([^\]]+)\]/.exec(update.path);
              if (match) names.add(match[1]!);
              collect(update.value.value);
            }
          }
          if (names.size) {
            setState({ names: [...names].sort() });
            return;
          }
        } catch {
          /* try the other model */
        }
      }
    })();
  }, [connected, loaded, controller, setState]);
  return state.names;
}

/** Autocomplete wires its input through slotProps; keep that wiring while shrinking the label. */
export function shrunkLabel(params: AutocompleteRenderInputParams): TextFieldProps {
  const props: TextFieldProps = params;
  return { ...props, slotProps: { ...props.slotProps, inputLabel: { ...params.slotProps.inputLabel, shrink: true } } };
}
