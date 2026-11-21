import { useEffect } from 'react';
import { create } from 'zustand';
import {
  HOST_MONITOR_WS_PATH,
  type HostMonitorClientMessage,
  type HostMonitorServerMessage,
  type MonitoredHost,
} from '@muxus/shared';
import { timedSample, type TimedSample } from '../host-stats.js';
import { monitorView, type MonitorReading } from '../host-monitor.js';
import { wsProtocols, wsUrl } from './http.js';

/** What the monitor asks the backend for. */
export interface HostMonitorWatch {
  intervalMs: number;
  gpu: boolean;
  /** Connections to read although nothing ran a command on them yet. */
  force: readonly string[];
}

interface HostMonitorState {
  /** The stream is up; readings arrive. */
  live: boolean;
  /** Every host Muxus is connected to, this computer first. */
  hosts: MonitoredHost[];
  readings: Record<string, MonitorReading>;
}

/**
 * The monitor's rows as the backend last described them. They outlive the
 * stream, so a monitor shown again has its last values at once.
 */
export const useHostMonitorStore = create<HostMonitorState>()(() => ({
  live: false,
  hosts: [],
  readings: {},
}));

const RECONNECT_MS = 2_000;
/**
 * Readings of many hosts arrive within moments of each other. They reach the
 * table together, so it draws once for the lot instead of once per host.
 */
const FLUSH_MS = 60;
/** Rates need two readings close together; older ones describe another moment. */
const MIN_RATE_GAP_SECONDS = 30;

let socket: WebSocket | undefined;
let wanted: HostMonitorWatch | undefined;
let reconnectTimer: number | undefined;
/** The last reading of each host, for the rates of the next. */
const latest = new Map<string, TimedSample>();
/** Readings that arrived and are not in the store yet. */
let pending: Record<string, MonitorReading> = {};
let flushTimer: number | undefined;

function flush(): void {
  window.clearTimeout(flushTimer);
  flushTimer = undefined;
  const arrived = pending;
  pending = {};
  if (Object.keys(arrived).length === 0) return;
  useHostMonitorStore.setState((state) => ({ readings: { ...state.readings, ...arrived } }));
}

function queue(id: string, reading: MonitorReading): void {
  pending[id] = reading;
  flushTimer ??= window.setTimeout(flush, FLUSH_MS);
}

function send(message: HostMonitorClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendWatch(): void {
  if (!wanted) return;
  send({ op: 'watch', intervalMs: wanted.intervalMs, gpu: wanted.gpu, force: [...wanted.force] });
}

function receive(message: HostMonitorServerMessage): void {
  switch (message.op) {
    case 'hosts': {
      flush();
      const present = new Set(message.hosts.map((host) => host.id));
      for (const id of latest.keys()) {
        if (!present.has(id)) latest.delete(id);
      }
      useHostMonitorStore.setState((state) => ({
        hosts: message.hosts,
        readings: Object.fromEntries(Object.entries(state.readings).filter(([id]) => present.has(id))),
      }));
      break;
    }
    case 'sample': {
      const current = timedSample(message.sample, message.sampledAt);
      const before = latest.get(message.id);
      const maxGap = Math.max(MIN_RATE_GAP_SECONDS, ((wanted?.intervalMs ?? 0) / 1000) * 3);
      const previous = before && current.at - before.at <= maxGap ? before : undefined;
      latest.set(message.id, current);
      queue(message.id, {
        status: 'ok',
        view: monitorView(current, previous),
        latencyMs: message.latencyMs,
        sampledAt: Date.now(),
      });
      break;
    }
    case 'state': {
      const known = pending[message.id] ?? useHostMonitorStore.getState().readings[message.id];
      queue(message.id, {
        // A reading that failed leaves the last values on screen, marked as old.
        ...(message.state === 'error' && known?.view
          ? { view: known.view, latencyMs: known.latencyMs, sampledAt: known.sampledAt }
          : {}),
        status: message.state,
        ...(message.message ? { message: message.message } : {}),
      });
      break;
    }
  }
}

function connect(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (socket || !wanted) return;
  const ws = new WebSocket(wsUrl(HOST_MONITOR_WS_PATH), wsProtocols());
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    useHostMonitorStore.setState({ live: true });
    sendWatch();
  };
  ws.onmessage = (event) => {
    if (socket !== ws || typeof event.data !== 'string') return;
    try {
      receive(JSON.parse(event.data) as HostMonitorServerMessage);
    } catch {
      // A frame that is not ours changes nothing.
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    useHostMonitorStore.setState({ live: false });
    if (wanted) reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  };
}

/**
 * Start, change or (with `undefined`) stop the stream. Stopped, the backend
 * reads no host for this window; the rows keep what they last showed.
 */
export function watchHosts(watch: HostMonitorWatch | undefined): void {
  wanted = watch;
  if (!watch) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const open = socket;
    socket = undefined;
    open?.close();
    flush();
    useHostMonitorStore.setState({ live: false });
    return;
  }
  if (socket) sendWatch();
  else connect();
}

/** Ask a host again that the backend gave up on. */
export function retryMonitoredHost(id: string): void {
  delete pending[id];
  useHostMonitorStore.setState((state) => ({
    readings: { ...state.readings, [id]: { status: 'waiting' } },
  }));
  send({ op: 'retry', id });
}

/** Run the stream while `watch` is given: the monitor is on screen. */
export function useHostMonitorStream(watch: HostMonitorWatch | undefined): void {
  const intervalMs = watch?.intervalMs;
  const gpu = watch?.gpu;
  // A new array every render names the same connections.
  const force = watch ? [...watch.force].sort().join('\n') : undefined;
  useEffect(() => {
    if (intervalMs === undefined || gpu === undefined || force === undefined) return;
    watchHosts({ intervalMs, gpu, force: force ? force.split('\n') : [] });
  }, [intervalMs, gpu, force]);
  const watching = watch !== undefined;
  useEffect(() => {
    if (!watching) return;
    return () => watchHosts(undefined);
  }, [watching]);
}
