// Package forwards runs SSH port forwards over live connections: local (-L),
// remote (-R) and dynamic (-D, a minimal no-auth SOCKS5 CONNECT server). All
// listeners bind 127.0.0.1 only — Muxus is a local single-user tool. Port of
// server/src/forwards/forward-manager.ts.
package forwards

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"

	gonanoid "github.com/matoous/go-nanoid/v2"

	"github.com/FloSch62/muxus/app/internal/api"
)

// HTTPError carries the status code the REST layer should answer with,
// mirroring the Node HttpProblem.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

func httpProblem(status int, format string, args ...any) *HTTPError {
	return &HTTPError{Status: status, Message: fmt.Sprintf(format, args...)}
}

// Conn is the slice of a managed SSH connection the forward manager needs;
// the sshx connection manager satisfies it.
type Conn interface {
	ID() string
	// DialTunnel opens a direct-tcpip channel to host:port (ssh -L / -D).
	DialTunnel(host string, port int) (net.Conn, error)
	// ListenRemote asks the server to listen on 127.0.0.1:port (ssh -R).
	ListenRemote(port int) (net.Listener, error)
	// OnClose subscribes to transport loss; returns an unsubscribe func.
	OnClose(listener func(reason string)) func()
}

// Connections is the acquisition surface: a live lease on the transport, or
// ok=false when the connection is unknown/closed.
type Connections interface {
	AcquireForward(connID string) (conn Conn, release func(), ok bool)
}

type activeForward struct {
	info *api.ForwardInfo
	stop func()
}

type Manager struct {
	connections Connections
	log         *slog.Logger

	mu       sync.Mutex
	forwards map[string]*activeForward
	order    []string
	// pendingConfigStarts collapses concurrent config-forward starts for the
	// same connection and rule into one listener bind.
	pendingConfigStarts map[string]chan struct{}
	pendingResults      map[string]*api.ForwardInfo
}

func NewManager(connections Connections, log *slog.Logger) *Manager {
	return &Manager{
		connections:         connections,
		log:                 log,
		forwards:            map[string]*activeForward{},
		pendingConfigStarts: map[string]chan struct{}{},
		pendingResults:      map[string]*api.ForwardInfo{},
	}
}

func (m *Manager) List(connID string) []api.ForwardInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []api.ForwardInfo{}
	for _, id := range m.order {
		active, ok := m.forwards[id]
		if !ok {
			continue
		}
		if connID == "" || active.info.ConnID == connID {
			out = append(out, *active.info)
		}
	}
	return out
}

func (m *Manager) Start(req api.ForwardRequest, origin string) (*api.ForwardInfo, error) {
	if req.Type != "dynamic" && (req.TargetHost == "" || req.TargetPort == 0) {
		return nil, httpProblem(400, "targetHost and targetPort are required for local/remote forwards")
	}
	conn, release, ok := m.connections.AcquireForward(req.ConnID)
	if !ok {
		return nil, httpProblem(404, "connection not found")
	}
	lifecycle := "session"
	if req.TunnelID != "" {
		lifecycle = "independent"
	}
	info := &api.ForwardInfo{
		ID:         gonanoid.Must(8),
		ConnID:     req.ConnID,
		Type:       req.Type,
		BindPort:   req.BindPort,
		TargetHost: req.TargetHost,
		TargetPort: req.TargetPort,
		Origin:     origin,
		Lifecycle:  lifecycle,
		Status:     "active",
		TunnelID:   req.TunnelID,
	}

	var stopTransport func()
	var err error
	switch req.Type {
	case "local":
		stopTransport, err = m.startLocal(conn, info)
	case "dynamic":
		stopTransport, err = m.startDynamic(conn, info)
	default:
		stopTransport, err = m.startRemote(conn, info)
	}
	if err != nil {
		release()
		return nil, err
	}

	var stopOnce sync.Once
	var unsubscribe func() = func() {}
	stop := func() {
		stopOnce.Do(func() {
			unsubscribe()
			defer release()
			stopTransport()
		})
	}
	m.mu.Lock()
	m.forwards[info.ID] = &activeForward{info: info, stop: stop}
	m.order = append(m.order, info.ID)
	m.mu.Unlock()
	unsubscribe = conn.OnClose(func(string) { m.Stop(info.ID) })
	return info, nil
}

func configForwardKey(connID, forwardType string, bindPort int, targetHost string, targetPort int) string {
	return connID + "\x00" + forwardType + "\x00" + strconv.Itoa(bindPort) + "\x00" + targetHost + "\x00" + strconv.Itoa(targetPort)
}

// StartConfig starts an ssh-config forward once per connection and rule.
// Every terminal on a multiplexed transport runs its resolved config through
// this method, so aliases can add distinct rules while repeated/concurrent
// sessions do not race into duplicate listener binds.
func (m *Manager) StartConfig(req api.ForwardRequest) (*api.ForwardInfo, bool, error) {
	key := configForwardKey(req.ConnID, req.Type, req.BindPort, req.TargetHost, req.TargetPort)

	for {
		m.mu.Lock()
		for _, id := range m.order {
			active, ok := m.forwards[id]
			if !ok {
				continue
			}
			info := active.info
			if info.Origin == "config" && info.Lifecycle == "session" &&
				configForwardKey(info.ConnID, info.Type, info.BindPort, info.TargetHost, info.TargetPort) == key {
				result := *info
				m.mu.Unlock()
				return &result, false, nil
			}
		}
		if pending, exists := m.pendingConfigStarts[key]; exists {
			m.mu.Unlock()
			<-pending
			m.mu.Lock()
			if result := m.pendingResults[key]; result != nil {
				copied := *result
				m.mu.Unlock()
				return &copied, false, nil
			}
			m.mu.Unlock()
			// The pending start failed; fall through and try our own.
			continue
		}
		pending := make(chan struct{})
		m.pendingConfigStarts[key] = pending
		m.mu.Unlock()

		info, err := m.Start(req, "config")
		m.mu.Lock()
		delete(m.pendingConfigStarts, key)
		if err == nil {
			m.pendingResults[key] = info
		} else {
			delete(m.pendingResults, key)
		}
		m.mu.Unlock()
		close(pending)
		if err != nil {
			return nil, false, err
		}
		return info, true, nil
	}
}

func (m *Manager) Stop(id string) {
	m.mu.Lock()
	active, ok := m.forwards[id]
	if ok {
		delete(m.forwards, id)
		m.removeFromOrder(id)
		m.clearPendingResult(active.info)
	}
	m.mu.Unlock()
	if ok {
		active.stop()
	}
}

// clearPendingResult must run with the lock held: a stopped config forward
// must not satisfy later StartConfig calls from the memoized result.
func (m *Manager) clearPendingResult(info *api.ForwardInfo) {
	if info.Origin != "config" {
		return
	}
	key := configForwardKey(info.ConnID, info.Type, info.BindPort, info.TargetHost, info.TargetPort)
	if result := m.pendingResults[key]; result != nil && result.ID == info.ID {
		delete(m.pendingResults, key)
	}
}

// AssignTunnel adopts a running forward into a saved tunnel (no restart).
func (m *Manager) AssignTunnel(id, tunnelID string) *api.ForwardInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	active, ok := m.forwards[id]
	if !ok {
		return nil
	}
	active.info.TunnelID = tunnelID
	active.info.Lifecycle = "independent"
	copied := *active.info
	return &copied
}

// StopSessionForConnection stops forwards owned by the terminal session
// while preserving saved/manual tunnels.
func (m *Manager) StopSessionForConnection(connID string) {
	m.mu.Lock()
	var stops []func()
	for id, active := range m.forwards {
		if active.info.ConnID == connID && active.info.Lifecycle == "session" {
			delete(m.forwards, id)
			m.removeFromOrder(id)
			m.clearPendingResult(active.info)
			stops = append(stops, active.stop)
		}
	}
	m.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	var stops []func()
	for _, active := range m.forwards {
		stops = append(stops, active.stop)
	}
	m.forwards = map[string]*activeForward{}
	m.order = nil
	m.pendingResults = map[string]*api.ForwardInfo{}
	m.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
}

func (m *Manager) removeFromOrder(id string) {
	for i, existing := range m.order {
		if existing == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			return
		}
	}
}

func listenLocal(port int) (net.Listener, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, httpProblem(400, "could not listen on 127.0.0.1:%d: %s", port, err.Error())
	}
	return listener, nil
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
	_ = a.Close()
	_ = b.Close()
}

// startLocal: listen locally, open a direct-tcpip channel per client.
func (m *Manager) startLocal(conn Conn, info *api.ForwardInfo) (func(), error) {
	listener, err := listenLocal(info.BindPort)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			socket, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				stream, dialErr := conn.DialTunnel(info.TargetHost, info.TargetPort)
				if dialErr != nil {
					m.log.Warn("forwardOut failed", "error", dialErr, "forward", info.ID)
					_ = socket.Close()
					return
				}
				pipe(socket, stream)
			}()
		}
	}()
	return func() { _ = listener.Close() }, nil
}

// startRemote: ask the server to listen; route incoming channels to the
// local target.
func (m *Manager) startRemote(conn Conn, info *api.ForwardInfo) (func(), error) {
	listener, err := conn.ListenRemote(info.BindPort)
	if err != nil {
		return nil, httpProblem(400, "remote bind failed: %s", err.Error())
	}
	go func() {
		for {
			stream, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				socket, dialErr := net.Dial("tcp", net.JoinHostPort(info.TargetHost, strconv.Itoa(info.TargetPort)))
				if dialErr != nil {
					_ = stream.Close()
					return
				}
				pipe(socket, stream)
			}()
		}
	}()
	return func() { _ = listener.Close() }, nil
}

// startDynamic: minimal SOCKS5 (no auth, CONNECT only) tunneling through the
// connection.
func (m *Manager) startDynamic(conn Conn, info *api.ForwardInfo) (func(), error) {
	listener, err := listenLocal(info.BindPort)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			socket, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go serveSocks5(socket, func(host string, port int) (net.Conn, error) {
				return conn.DialTunnel(host, port)
			})
		}
	}()
	return func() { _ = listener.Close() }, nil
}
