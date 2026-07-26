/** Conservative share of the browser's 64 KiB page-wide keepalive body quota. */
export const PAGE_KEEPALIVE_BODY_LIMIT_BYTES = 60_000;

export interface UnloadKeepaliveFlush {
  /** Higher-priority work consumes its share before lower-priority work. */
  priority: number;
  /** Cheap check used to divide a priority group's share only among active work. */
  isPending?: () => boolean;
  /** Queue at most `maxBodyBytes`, returning the body bytes actually queued. */
  flush: (maxBodyBytes: number) => number;
}

const flushes = new Set<UnloadKeepaliveFlush>();
let listening = false;

/** UTF-8 wire size of a request body. */
export function requestBodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * Run page-unload work inside one shared body budget.
 *
 * Equal-priority callbacks split the remaining quota fairly. A multi-pane
 * workspace therefore gives every terminal a chance to save a smaller tail
 * instead of letting the first terminal consume the whole allowance.
 */
export function flushUnloadKeepalives(
  pending: readonly UnloadKeepaliveFlush[],
  maxBodyBytes = PAGE_KEEPALIVE_BODY_LIMIT_BYTES,
): number {
  const totalBudget = Math.max(0, Math.floor(maxBodyBytes));
  let remaining = totalBudget;
  const groups = new Map<number, UnloadKeepaliveFlush[]>();
  for (const task of pending) {
    try {
      if (task.isPending && !task.isPending()) continue;
    } catch {
      continue;
    }
    const group = groups.get(task.priority) ?? [];
    group.push(task);
    groups.set(task.priority, group);
  }

  const priorities = [...groups.keys()].sort((left, right) => right - left);
  for (const priority of priorities) {
    const group = groups.get(priority)!;
    for (let index = 0; index < group.length && remaining > 0; index++) {
      const fairShare = Math.floor(remaining / (group.length - index));
      if (fairShare === 0) break;
      try {
        const used = group[index]!.flush(fairShare);
        if (Number.isFinite(used) && used > 0) {
          remaining -= Math.min(fairShare, Math.floor(used));
        }
      } catch {
        // One optional persistence task must not prevent the others from flushing.
      }
    }
  }
  return totalBudget - remaining;
}

function flushPage(): void {
  flushUnloadKeepalives([...flushes]);
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('beforeunload', flushPage);
  window.addEventListener('pagehide', flushPage);
}

function stopListening(): void {
  if (!listening || flushes.size > 0) return;
  listening = false;
  window.removeEventListener('beforeunload', flushPage);
  window.removeEventListener('pagehide', flushPage);
}

/** Register unload persistence while keeping one pair of page-wide listeners. */
export function registerUnloadKeepalive(
  flush: UnloadKeepaliveFlush['flush'],
  options: Pick<UnloadKeepaliveFlush, 'priority' | 'isPending'> = { priority: 0 },
): () => void {
  const task = { ...options, flush };
  flushes.add(task);
  startListening();
  return () => {
    flushes.delete(task);
    stopListening();
  };
}
