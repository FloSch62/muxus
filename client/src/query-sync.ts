import type {
  InvalidateOptions,
  InvalidateQueryFilters,
  QueryClient,
  QueryKey,
  SetDataOptions,
} from '@tanstack/react-query';

const CHANNEL_NAME = 'muxus-query-sync-v1';

/** Query keys another window changed; `null` stands for every query. */
interface StaleQueriesMessage {
  kind: 'stale';
  queryKeys: Array<QueryKey | null>;
}

function isStaleQueriesMessage(value: unknown): value is StaleQueriesMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === 'stale' &&
    Array.isArray(message.queryKeys) &&
    message.queryKeys.every((key) => key === null || Array.isArray(key))
  );
}

function defaultChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
}

function keyId(queryKey: QueryKey | null): string {
  try {
    return JSON.stringify(queryKey);
  } catch {
    return 'null';
  }
}

/**
 * Windows share one server, but each keeps its own query cache. Whatever one
 * window invalidates, or replaces after a write, goes stale in the others as
 * well, so hosts imported or a vault unlocked in one window (the settings
 * window, most often) show up in every other without a reload. What arrives
 * is applied locally only and never passed on again. Returns a teardown.
 */
export function shareQueryChanges(
  client: QueryClient,
  channel: BroadcastChannel | undefined = defaultChannel(),
): () => void {
  if (!channel) return () => undefined;
  const invalidateQueries = client.invalidateQueries.bind(client);
  const setQueryData = client.setQueryData.bind(client);
  let pending: Map<string, QueryKey | null> | undefined;
  let stopped = false;

  // One message per task, however many keys a mutation touches.
  const flush = () => {
    if (!pending) return;
    const queryKeys = pending.has('null') ? [null] : [...pending.values()];
    pending = undefined;
    // A key that cannot be cloned still makes the other windows refetch.
    for (const keys of [queryKeys, [null]]) {
      try {
        channel.postMessage({ kind: 'stale', queryKeys: keys } satisfies StaleQueriesMessage);
        return;
      } catch {
        /* closed channel or uncloneable key */
      }
    }
  };
  const share = (queryKey: QueryKey | undefined) => {
    if (stopped) return;
    if (!pending) {
      pending = new Map();
      queueMicrotask(flush);
    }
    const key = queryKey ?? null;
    const id = keyId(key);
    pending.set(id, id === 'null' ? null : key);
  };

  client.invalidateQueries = ((filters?: InvalidateQueryFilters, options?: InvalidateOptions) => {
    // A predicate cannot travel; the other windows refetch everything instead.
    share(filters?.predicate ? undefined : filters?.queryKey);
    return invalidateQueries(filters, options);
  }) as QueryClient['invalidateQueries'];
  client.setQueryData = ((queryKey: QueryKey, updater: unknown, options?: SetDataOptions) => {
    share(queryKey);
    return setQueryData(queryKey, updater as never, options);
  }) as unknown as QueryClient['setQueryData'];

  const receive = (event: MessageEvent) => {
    if (!isStaleQueriesMessage(event.data)) return;
    for (const queryKey of event.data.queryKeys) {
      void invalidateQueries(queryKey === null ? undefined : { queryKey });
    }
  };
  channel.addEventListener('message', receive);
  return () => {
    stopped = true;
    pending = undefined;
    channel.removeEventListener('message', receive);
    channel.close();
  };
}
