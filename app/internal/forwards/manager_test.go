package forwards

import (
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/FloSch62/muxus/app/internal/api"
)

type fakeForwardConn struct {
	mu       sync.Mutex
	onClose  func(string)
	dialHost string
	dialPort int
}

func (c *fakeForwardConn) ID() string { return "conn-1" }

func (c *fakeForwardConn) DialTunnel(host string, port int) (net.Conn, error) {
	c.mu.Lock()
	c.dialHost, c.dialPort = host, port
	c.mu.Unlock()
	local, remote := net.Pipe()
	go func() {
		defer remote.Close()
		_, _ = io.Copy(remote, remote)
	}()
	return local, nil
}

func (c *fakeForwardConn) ListenRemote(int) (net.Listener, error) {
	return nil, &net.OpError{Op: "listen", Net: "tcp", Err: net.ErrClosed}
}

func (c *fakeForwardConn) OnClose(listener func(string)) func() {
	c.mu.Lock()
	c.onClose = listener
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		c.onClose = nil
		c.mu.Unlock()
	}
}

type fakeForwardConnections struct {
	conn     *fakeForwardConn
	acquired int
	released int
}

func (c *fakeForwardConnections) AcquireForward(id string) (Conn, func(), bool) {
	if id != c.conn.ID() {
		return nil, nil, false
	}
	c.acquired++
	return c.conn, func() { c.released++ }, true
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func TestLocalForwardLifecycleAndDataPath(t *testing.T) {
	connections := &fakeForwardConnections{conn: &fakeForwardConn{}}
	manager := NewManager(connections, slog.New(slog.NewTextHandler(io.Discard, nil)))
	port := freeTCPPort(t)
	info, err := manager.Start(api.ForwardRequest{
		ConnID: "conn-1", Type: "local", BindPort: port,
		TargetHost: "database.internal", TargetPort: 5432,
	}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if info.Status != "active" || info.Lifecycle != "session" || len(manager.List("")) != 1 {
		t.Fatalf("forward = %+v list=%+v", info, manager.List(""))
	}

	socket, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := socket.Write([]byte("muxus")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 5)
	if _, err := io.ReadFull(socket, reply); err != nil {
		t.Fatal(err)
	}
	_ = socket.Close()
	if string(reply) != "muxus" {
		t.Fatalf("reply = %q", reply)
	}
	connections.conn.mu.Lock()
	host, targetPort := connections.conn.dialHost, connections.conn.dialPort
	connections.conn.mu.Unlock()
	if host != "database.internal" || targetPort != 5432 {
		t.Fatalf("target = %s:%d", host, targetPort)
	}

	manager.Stop(info.ID)
	if len(manager.List("")) != 0 || connections.acquired != 1 || connections.released != 1 {
		t.Fatalf("after stop: list=%+v acquired=%d released=%d",
			manager.List(""), connections.acquired, connections.released)
	}
}

func TestForwardErrorsAndTunnelAdoption(t *testing.T) {
	connections := &fakeForwardConnections{conn: &fakeForwardConn{}}
	manager := NewManager(connections, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := manager.Start(api.ForwardRequest{
		ConnID: "missing", Type: "local", BindPort: freeTCPPort(t),
		TargetHost: "host", TargetPort: 80,
	}, "manual"); err == nil {
		t.Fatal("missing connection accepted")
	} else if problem, ok := err.(*HTTPError); !ok || problem.Status != 404 {
		t.Fatalf("error = %#v", err)
	}

	info, err := manager.Start(api.ForwardRequest{
		ConnID: "conn-1", Type: "dynamic", BindPort: freeTCPPort(t),
	}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	adopted := manager.AssignTunnel(info.ID, "tunnel-1")
	if adopted == nil || adopted.TunnelID != "tunnel-1" || adopted.Lifecycle != "independent" {
		t.Fatalf("adopted = %+v", adopted)
	}
	manager.StopSessionForConnection("conn-1")
	if len(manager.List("")) != 1 {
		t.Fatal("independent tunnel stopped with terminal session")
	}
	manager.StopAll()
	if connections.released != 1 {
		t.Fatalf("release count = %d", connections.released)
	}
}
