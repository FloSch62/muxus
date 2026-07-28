// Package sshx dials and manages SSH transports the way `ssh <target>`
// would: OpenSSH config resolution, ProxyJump chains, known_hosts
// verification, and ControlMaster-style connection sharing.
package sshx

import (
	"fmt"
	"sync"
)

// LeaseOwner mirrors ConnectionLeaseOwner.
type LeaseOwner string

const (
	OwnerTerminal LeaseOwner = "terminal"
	OwnerSftp     LeaseOwner = "sftp"
	OwnerForward  LeaseOwner = "forward"
	OwnerEditor   LeaseOwner = "editor"
	OwnerDial     LeaseOwner = "dial"
)

// Leaseable is the minimal surface a transport must expose to the registry.
type Leaseable interface {
	ID() string
	Close()
}

// Lease is one consumer's hold on a transport. Release is idempotent; the
// transport closes after its final lease is released.
type Lease[T Leaseable] struct {
	Connection T
	Owner      LeaseOwner
	release    func()
}

func (l *Lease[T]) Release() { l.release() }

type leaseRecord[T Leaseable] struct {
	connection  T
	leases      map[int]LeaseOwner
	nextLeaseID int
	closing     bool
}

// LeaseRegistry owns transport lifetimes independently from UI/channel
// lifetimes: every terminal, SFTP operation, forward, or editor holds a
// lease, and the underlying transport closes after the last consumer leaves
// or when CloseAll forces shutdown. Port of ConnectionLeaseRegistry.
type LeaseRegistry[T Leaseable] struct {
	mu      sync.Mutex
	records map[string]*leaseRecord[T]
	order   []string
}

func NewLeaseRegistry[T Leaseable]() *LeaseRegistry[T] {
	return &LeaseRegistry[T]{records: map[string]*leaseRecord[T]{}}
}

func (r *LeaseRegistry[T]) Register(connection T, owner LeaseOwner) (*Lease[T], error) {
	r.mu.Lock()
	if _, exists := r.records[connection.ID()]; exists {
		r.mu.Unlock()
		return nil, fmt.Errorf("connection %q is already registered", connection.ID())
	}
	r.records[connection.ID()] = &leaseRecord[T]{
		connection:  connection,
		leases:      map[int]LeaseOwner{},
		nextLeaseID: 1,
	}
	r.order = append(r.order, connection.ID())
	r.mu.Unlock()
	lease := r.Acquire(connection.ID(), owner)
	if lease == nil {
		return nil, fmt.Errorf("connection %q closed during registration", connection.ID())
	}
	return lease, nil
}

func (r *LeaseRegistry[T]) Get(id string) (T, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var zero T
	record, ok := r.records[id]
	if !ok || record.closing {
		return zero, false
	}
	return record.connection, true
}

// List returns all live (non-closing) transports in registration order.
func (r *LeaseRegistry[T]) List() []T {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]T, 0, len(r.order))
	for _, id := range r.order {
		if record, ok := r.records[id]; ok && !record.closing {
			out = append(out, record.connection)
		}
	}
	return out
}

// LeaseCount reports live leases on id, optionally counting only the given
// owner kinds.
func (r *LeaseRegistry[T]) LeaseCount(id string, owners ...LeaseOwner) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.records[id]
	if !ok || record.closing {
		return 0
	}
	if len(owners) == 0 {
		return len(record.leases)
	}
	count := 0
	for _, owner := range record.leases {
		for _, want := range owners {
			if owner == want {
				count++
				break
			}
		}
	}
	return count
}

func (r *LeaseRegistry[T]) Acquire(id string, owner LeaseOwner) *Lease[T] {
	r.mu.Lock()
	record, ok := r.records[id]
	if !ok || record.closing {
		r.mu.Unlock()
		return nil
	}
	leaseID := record.nextLeaseID
	record.nextLeaseID++
	record.leases[leaseID] = owner
	r.mu.Unlock()

	var releaseOnce sync.Once
	lease := &Lease[T]{Connection: record.connection, Owner: owner}
	lease.release = func() {
		releaseOnce.Do(func() {
			r.mu.Lock()
			if _, live := record.leases[leaseID]; !live {
				r.mu.Unlock()
				return
			}
			delete(record.leases, leaseID)
			if record.closing || len(record.leases) > 0 {
				r.mu.Unlock()
				return
			}
			record.closing = true
			r.mu.Unlock()
			// Close outside the lock: transport close handlers may re-enter
			// the registry (markClosed).
			record.connection.Close()
		})
	}
	return lease
}

// MarkClosed records an already-closed transport and invalidates all
// outstanding leases.
func (r *LeaseRegistry[T]) MarkClosed(connection T) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.records[connection.ID()]
	if !ok || record.connection.ID() != connection.ID() {
		return
	}
	record.closing = true
	record.leases = map[int]LeaseOwner{}
	delete(r.records, connection.ID())
	r.removeFromOrder(connection.ID())
}

func (r *LeaseRegistry[T]) removeFromOrder(id string) {
	for i, existing := range r.order {
		if existing == id {
			r.order = append(r.order[:i], r.order[i+1:]...)
			return
		}
	}
}

func (r *LeaseRegistry[T]) CloseAll() {
	r.mu.Lock()
	records := make([]*leaseRecord[T], 0, len(r.records))
	for _, record := range r.records {
		record.closing = true
		record.leases = map[int]LeaseOwner{}
		records = append(records, record)
	}
	r.records = map[string]*leaseRecord[T]{}
	r.order = nil
	r.mu.Unlock()
	for _, record := range records {
		record.connection.Close()
	}
}
