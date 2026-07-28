package sshx

import (
	"sync/atomic"
	"testing"
)

// Cases ported from tests/unit/server/connection-leases.test.ts.

type fakeConn struct {
	id     string
	closes atomic.Int32
}

func (f *fakeConn) ID() string { return f.id }
func (f *fakeConn) Close()     { f.closes.Add(1) }

func newFakeConn(id string) *fakeConn { return &fakeConn{id: id} }

func TestTransportAliveUntilFinalConsumerReleases(t *testing.T) {
	registry := NewLeaseRegistry[*fakeConn]()
	transport := newFakeConn("connection-1")
	terminal, err := registry.Register(transport, OwnerTerminal)
	if err != nil {
		t.Fatal(err)
	}
	forward := registry.Acquire(transport.ID(), OwnerForward)
	sftp := registry.Acquire(transport.ID(), OwnerSftp)

	terminal.Release()
	sftp.Release()
	if transport.closes.Load() != 0 {
		t.Fatal("transport must stay open while a lease remains")
	}
	if got, ok := registry.Get(transport.ID()); !ok || got != transport {
		t.Fatal("transport must remain retrievable")
	}

	forward.Release()
	if transport.closes.Load() != 1 {
		t.Fatalf("close calls = %d, want 1", transport.closes.Load())
	}
	if registry.Acquire(transport.ID(), OwnerEditor) != nil {
		t.Fatal("closed transport must not hand out leases")
	}

	forward.Release()
	if transport.closes.Load() != 1 {
		t.Fatal("release must be idempotent")
	}
}

func TestLeasesInvalidatedWhenRemoteClosesFirst(t *testing.T) {
	registry := NewLeaseRegistry[*fakeConn]()
	transport := newFakeConn("connection-1")
	terminal, _ := registry.Register(transport, OwnerTerminal)
	forward := registry.Acquire(transport.ID(), OwnerForward)

	registry.MarkClosed(transport)
	terminal.Release()
	forward.Release()

	if _, ok := registry.Get(transport.ID()); ok {
		t.Fatal("closed transport must be gone")
	}
	if transport.closes.Load() != 0 {
		t.Fatal("registry must not close a transport the remote already closed")
	}
}

func TestTunnelStartHandover(t *testing.T) {
	registry := NewLeaseRegistry[*fakeConn]()
	transport := newFakeConn("connection-1")
	dial, _ := registry.Register(transport, OwnerDial)
	forward := registry.Acquire(transport.ID(), OwnerForward)

	dial.Release()
	if transport.closes.Load() != 0 {
		t.Fatal("tunnel must survive the dial lease release")
	}
	if list := registry.List(); len(list) != 1 || list[0] != transport {
		t.Fatalf("list = %v", list)
	}

	forward.Release()
	if transport.closes.Load() != 1 {
		t.Fatal("transport must close with the final lease")
	}
	if len(registry.List()) != 0 {
		t.Fatal("closed transport must leave the list")
	}
}

func TestLeaseCountsByOwnerKind(t *testing.T) {
	registry := NewLeaseRegistry[*fakeConn]()
	transport := newFakeConn("connection-1")
	terminal, _ := registry.Register(transport, OwnerTerminal)
	registry.Acquire(transport.ID(), OwnerTerminal)
	forward := registry.Acquire(transport.ID(), OwnerForward)

	if got := registry.LeaseCount(transport.ID()); got != 3 {
		t.Fatalf("total leases = %d, want 3", got)
	}
	if got := registry.LeaseCount(transport.ID(), OwnerTerminal, OwnerDial); got != 2 {
		t.Fatalf("terminal+dial leases = %d, want 2", got)
	}
	if got := registry.LeaseCount(transport.ID(), OwnerSftp); got != 0 {
		t.Fatalf("sftp leases = %d, want 0", got)
	}
	if got := registry.LeaseCount("missing"); got != 0 {
		t.Fatalf("missing id leases = %d, want 0", got)
	}

	terminal.Release()
	if got := registry.LeaseCount(transport.ID(), OwnerTerminal, OwnerDial); got != 1 {
		t.Fatalf("after release = %d, want 1", got)
	}

	registry.MarkClosed(transport)
	if got := registry.LeaseCount(transport.ID()); got != 0 {
		t.Fatalf("after markClosed = %d, want 0", got)
	}
	forward.Release()
}

func TestCloseAllForcesShutdown(t *testing.T) {
	registry := NewLeaseRegistry[*fakeConn]()
	first := newFakeConn("first")
	second := newFakeConn("second")
	_, _ = registry.Register(first, OwnerTerminal)
	_, _ = registry.Register(second, OwnerForward)

	registry.CloseAll()

	if first.closes.Load() != 1 || second.closes.Load() != 1 {
		t.Fatalf("close calls = %d/%d, want 1/1", first.closes.Load(), second.closes.Load())
	}
	if _, ok := registry.Get("first"); ok {
		t.Fatal("first must be gone")
	}
	if _, ok := registry.Get("second"); ok {
		t.Fatal("second must be gone")
	}
}
