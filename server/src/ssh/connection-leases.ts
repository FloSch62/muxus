export type ConnectionLeaseOwner = 'terminal' | 'sftp' | 'forward' | 'editor' | 'dial';

export interface LeaseableConnection {
  readonly id: string;
  close(): void;
}

export interface TransportLease<T extends LeaseableConnection> {
  readonly connection: T;
  readonly owner: ConnectionLeaseOwner;
  /** Idempotent. The transport closes after its final lease is released. */
  release(): void;
}

interface ConnectionRecord<T> {
  connection: T;
  leases: Map<number, ConnectionLeaseOwner>;
  nextLeaseId: number;
  closing: boolean;
}

/**
 * Owns transport lifetimes independently from UI/channel lifetimes.
 *
 * Every terminal, SFTP operation, forward, or editor holds a lease. Closing
 * one consumer releases only that lease; the underlying transport closes
 * after the last consumer leaves or when closeAll() forces shutdown.
 */
export class ConnectionLeaseRegistry<T extends LeaseableConnection> {
  private readonly records = new Map<string, ConnectionRecord<T>>();

  register(connection: T, owner: ConnectionLeaseOwner): TransportLease<T> {
    if (this.records.has(connection.id)) throw new Error(`connection "${connection.id}" is already registered`);
    this.records.set(connection.id, {
      connection,
      leases: new Map(),
      nextLeaseId: 1,
      closing: false,
    });
    return this.acquire(connection.id, owner)!;
  }

  get(id: string): T | undefined {
    const record = this.records.get(id);
    return record && !record.closing ? record.connection : undefined;
  }

  /** All live (non-closing) transports, registration order. */
  list(): T[] {
    return [...this.records.values()].filter((record) => !record.closing).map((record) => record.connection);
  }

  /** Live leases on `id`, optionally counting only the given owner kinds. */
  leaseCount(id: string, owners?: readonly ConnectionLeaseOwner[]): number {
    const record = this.records.get(id);
    if (!record || record.closing) return 0;
    if (!owners) return record.leases.size;
    let count = 0;
    for (const owner of record.leases.values()) if (owners.includes(owner)) count += 1;
    return count;
  }

  acquire(id: string, owner: ConnectionLeaseOwner): TransportLease<T> | undefined {
    const record = this.records.get(id);
    if (!record || record.closing) return undefined;
    const leaseId = record.nextLeaseId++;
    record.leases.set(leaseId, owner);
    let released = false;
    return {
      connection: record.connection,
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (!record.leases.delete(leaseId) || record.closing || record.leases.size > 0) return;
        record.closing = true;
        record.connection.close();
      },
    };
  }

  /** Record an already-closed transport and invalidate all outstanding leases. */
  markClosed(connection: T): void {
    const record = this.records.get(connection.id);
    if (!record || record.connection !== connection) return;
    record.closing = true;
    record.leases.clear();
    this.records.delete(connection.id);
  }

  closeAll(): void {
    const records = [...this.records.values()];
    this.records.clear();
    for (const record of records) {
      record.closing = true;
      record.leases.clear();
      record.connection.close();
    }
  }
}
