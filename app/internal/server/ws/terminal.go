package ws

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/forwards"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/sshx"
)

const (
	connectTimeout = 30 * time.Second
	keepaliveEvery = 30 * time.Second
	maxPayload     = 16 * 1024 * 1024
	// Blocking writes on the peer's TCP window replace the Node
	// bufferedAmount pause/resume polling: a runaway `cat hugefile` parks the
	// transport read loop inside conn.Write until the browser drains.
	writeWait = 60 * time.Second
)

// TerminalTransport is the byte transport behind a telnet or serial session
// (transports/terminal-transport.ts). Read returning io.EOF means the
// transport completed; any other error is a failure.
type TerminalTransport interface {
	io.Reader
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Close() error
}

// LocalPty is a spawned local shell. Wait blocks until exit and reports the
// exit code.
type LocalPty interface {
	TerminalTransport
	Wait() int
	Kill()
}

// LoggingState mirrors SessionLoggingState.
type LoggingState struct {
	Enabled      bool
	SessionID    string
	Paused       bool
	CaptureInput bool
	Warning      string
}

// Recorder is the session-logging surface the socket needs; the real
// implementation writes to the history store; NoopRecorder covers disabled
// logging and lightweight test setups.
type Recorder interface {
	Input(data []byte)
	Output(data []byte)
	System(message string)
	State() LoggingState
	SetState(enabled, paused, captureInput *bool) LoggingState
	OnStateChange(fn func(LoggingState))
	End(reason string)
}

// ConnectIo carries the status/prompt/host-key callbacks a connection setup
// uses to talk to the terminal (ssh/connection-manager.ts ConnectIo).
type ConnectIo struct {
	Status  func(message string, transient bool)
	Prompt  func(prompt api.AuthPromptMessage) ([]string, error)
	HostKey func(challenge api.HostKeyMessage) (bool, error)
}

// Deps supplies subsystem constructors so tests and embedders can substitute
// transports without changing the wire protocol.
type Deps struct {
	SpawnLocalPty func(profile *api.LocalProfile, cols, rows int) (LocalPty, string, error)
	SerialConnect func(profile *api.SerialProfile) (TerminalTransport, error)
	TelnetConnect func(profile *api.TelnetProfile, cols, rows int) (TerminalTransport, error)
	NewRecorder   func(profile api.SessionProfile, title string) Recorder
	NewID         func() string
	Connections   *sshx.ConnectionManager
	Forwards      *forwards.Manager
	Database      *persist.DB
	Log           *slog.Logger
}

func (d *Deps) recorder(profile api.SessionProfile, title string) Recorder {
	if d.NewRecorder == nil {
		return &NoopRecorder{}
	}
	return d.NewRecorder(profile, title)
}

// NoopRecorder reports logging disabled while set-logging still round-trips
// state.
type NoopRecorder struct {
	mu    sync.Mutex
	state LoggingState
}

func (n *NoopRecorder) Input([]byte)                     {}
func (n *NoopRecorder) Output([]byte)                    {}
func (n *NoopRecorder) System(string)                    {}
func (n *NoopRecorder) OnStateChange(func(LoggingState)) {}
func (n *NoopRecorder) End(string)                       {}
func (n *NoopRecorder) State() LoggingState {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.state
}

func (n *NoopRecorder) SetState(enabled, paused, captureInput *bool) LoggingState {
	n.mu.Lock()
	defer n.mu.Unlock()
	if paused != nil {
		n.state.Paused = *paused
	}
	if captureInput != nil {
		n.state.CaptureInput = *captureInput
	}
	return n.state
}

// wsConn serializes writes: gorilla allows a single concurrent writer, and
// synchronous writes are what give us flow control.
type wsConn struct {
	mu     sync.Mutex
	conn   *websocket.Conn
	closed bool
}

func (w *wsConn) sendBinary(data []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	_ = w.conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := w.conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		w.closed = true
	}
}

func (w *wsConn) sendControl(msg any) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	_ = w.conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := w.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		w.closed = true
	}
}

func (w *wsConn) ping() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	_ = w.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
}

func (w *wsConn) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	_ = w.conn.Close()
}

// session bundles the per-socket state shared between the reader goroutine
// and the handler.
type session struct {
	ws      *wsConn
	control *ControlChannel
	deps    *Deps

	mu         sync.Mutex
	writeInput func(data []byte)
	recorder   Recorder
	open       bool
	onClose    []func()
	closed     chan struct{}
}

func (s *session) setWriteInput(fn func(data []byte)) {
	s.mu.Lock()
	s.writeInput = fn
	s.mu.Unlock()
}

func (s *session) input(data []byte) {
	s.mu.Lock()
	write := s.writeInput
	recorder := s.recorder
	s.mu.Unlock()
	if write == nil {
		return
	}
	if recorder != nil {
		recorder.Input(data)
	}
	write(data)
}

func (s *session) setRecorder(r Recorder) {
	s.mu.Lock()
	s.recorder = r
	s.mu.Unlock()
}

func (s *session) isOpen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.open
}

// addOnClose registers a cleanup run exactly once when the socket closes.
func (s *session) addOnClose(fn func()) {
	s.mu.Lock()
	if !s.open {
		s.mu.Unlock()
		fn()
		return
	}
	s.onClose = append(s.onClose, fn)
	s.mu.Unlock()
}

func (s *session) markClosed() {
	s.mu.Lock()
	if !s.open {
		s.mu.Unlock()
		return
	}
	s.open = false
	handlers := s.onClose
	s.onClose = nil
	close(s.closed)
	s.mu.Unlock()
	for _, fn := range handlers {
		fn()
	}
	s.control.Close()
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 64 * 1024,
	// Origin and token are checked before Upgrade is called.
	CheckOrigin:  func(*http.Request) bool { return true },
	Subprotocols: []string{server.TerminalWSProtocol},
}

// UpgradeTerminal authenticates and upgrades a terminal WebSocket request.
func UpgradeTerminal(w http.ResponseWriter, r *http.Request, token string) (*websocket.Conn, error) {
	if !server.OriginAllowed(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return nil, errors.New("forbidden origin")
	}
	if !server.WebsocketHeaderHasToken(r.Header.Values("Sec-Websocket-Protocol"), token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return nil, errors.New("unauthorized websocket")
	}
	if !offersProtocol(r, server.TerminalWSProtocol) {
		http.Error(w, "unsupported protocol", http.StatusBadRequest)
		return nil, errors.New("missing terminal subprotocol")
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(maxPayload)
	return conn, nil
}

func offersProtocol(r *http.Request, want string) bool {
	for _, raw := range r.Header.Values("Sec-Websocket-Protocol") {
		for _, p := range strings.Split(raw, ",") {
			if strings.TrimSpace(p) == want {
				return true
			}
		}
	}
	return false
}

// RegisterTerminalSocket mirrors registerTerminalSocket.
func RegisterTerminalSocket(r chi.Router, ctx *server.Context, deps *Deps) {
	r.Get("/ws/terminal", func(w http.ResponseWriter, req *http.Request) {
		conn, err := UpgradeTerminal(w, req, ctx.Config.Token)
		if err != nil {
			return
		}
		go runTerminalSession(conn, deps)
	})
}

func runTerminalSession(conn *websocket.Conn, deps *Deps) {
	s := &session{
		ws:      &wsConn{conn: conn},
		control: &ControlChannel{},
		deps:    deps,
		open:    true,
		closed:  make(chan struct{}),
	}
	defer s.ws.close()
	defer s.markClosed()

	go s.readLoop(conn)

	if err := s.handle(); err != nil {
		if deps.Log != nil {
			deps.Log.Warn("terminal session failed", "error", err)
		}
		code := 1
		s.ws.sendControl(api.ExitMessage{Op: "exit", Code: &code, Message: err.Error(), Reason: "failed"})
	}
}

// readLoop splits frames: binary (or non-JSON text — some clients send text
// input) is terminal input; JSON text frames are control messages; frames
// failing validation are dropped, matching safeParse.
func (s *session) readLoop(conn *websocket.Conn) {
	defer s.markClosed()
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch msgType {
		case websocket.BinaryMessage:
			s.input(data)
		case websocket.TextMessage:
			if !json.Valid(data) {
				s.input(data)
				continue
			}
			msg, err := api.ParseTerminalClientMessage(data)
			if err != nil {
				continue
			}
			s.control.Push(msg)
		}
	}
}

func (s *session) awaitFirstMessage() (api.TerminalClientMessage, error) {
	type result struct {
		msg api.TerminalClientMessage
		err error
	}
	ch := make(chan result, 1)
	go func() {
		msg, err := s.control.Next()
		ch <- result{msg, err}
	}()
	select {
	case r := <-ch:
		return r.msg, r.err
	case <-time.After(connectTimeout):
		return api.TerminalClientMessage{}, errors.New("timed out waiting for connect")
	}
}

func (s *session) handle() error {
	first, err := s.awaitFirstMessage()
	if err != nil {
		return err
	}
	if first.Connect == nil && first.Dial == nil {
		return errors.New("expected connect or dial")
	}
	if !s.isOpen() {
		return nil
	}

	stopKeepalive := make(chan struct{})
	s.addOnClose(func() { close(stopKeepalive) })
	go func() {
		ticker := time.NewTicker(keepaliveEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.ws.ping()
			case <-stopKeepalive:
				return
			}
		}
	}()

	if first.Dial != nil {
		return s.runDial(first.Dial.Profile)
	}

	connect := first.Connect
	recorder := s.deps.recorder(connect.Profile, connect.Title)
	s.setRecorder(recorder)
	sendLoggingState := func(state LoggingState) {
		s.ws.sendControl(api.LoggingStateMessage{
			Op:           "logging-state",
			Enabled:      state.Enabled,
			SessionID:    state.SessionID,
			Paused:       state.Paused,
			CaptureInput: state.CaptureInput,
			Warning:      state.Warning,
		})
	}
	recorder.OnStateChange(sendLoggingState)
	handleLoggingControl := func(msg api.TerminalClientMessage) bool {
		if msg.SetLogging == nil {
			return false
		}
		sendLoggingState(recorder.SetState(msg.SetLogging.Enabled, msg.SetLogging.Paused, msg.SetLogging.CaptureInput))
		return true
	}
	s.control.SetHandlers(handleLoggingControl, nil)
	sendLoggingState(recorder.State())
	s.addOnClose(func() { recorder.End("disconnected") })

	switch {
	case connect.Profile.Local != nil:
		return s.runLocal(connect, recorder, handleLoggingControl)
	case connect.Profile.Serial != nil:
		return s.runSerial(connect, recorder, handleLoggingControl)
	case connect.Profile.Telnet != nil:
		return s.runTelnet(connect, recorder, handleLoggingControl)
	default:
		return s.runSSH(connect, recorder, handleLoggingControl)
	}
}

func (s *session) connectIO(recorder Recorder) sshx.ConnectIO {
	return sshx.ConnectIO{
		Status: func(message string, transient bool) {
			if recorder != nil {
				recorder.System(message)
			}
			s.ws.sendControl(api.NewStatus(message, transient))
		},
		Prompt: func(info sshx.PromptInfo) ([]string, error) {
			s.ws.sendControl(api.AuthPromptMessage{
				Op: "auth-prompt", Name: info.Name, Instructions: info.Instructions,
				Host: info.Host, Prompts: info.Prompts,
			})
			reply, err := s.control.Next()
			if err != nil || reply.AuthResponse == nil {
				return nil, errors.New("authentication cancelled")
			}
			return reply.AuthResponse.Answers, nil
		},
		HostKey: func(challenge sshx.HostKeyChallenge) (bool, error) {
			s.ws.sendControl(api.HostKeyMessage{
				Op: "host-key", Host: challenge.Host, Port: challenge.Port,
				KeyType: challenge.KeyType, Fingerprint: challenge.Fingerprint,
				State: challenge.State, Previous: challenge.Previous, Hop: challenge.Hop,
			})
			reply, err := s.control.Next()
			if err != nil || reply.HostKeyResponse == nil {
				return false, nil
			}
			return reply.HostKeyResponse.Accept, nil
		},
	}
}

func (s *session) recordSSHConnection(connection *sshx.Connection) {
	if s.deps.Database == nil || connection.MetadataAlias() == "" {
		return
	}
	if _, err := s.deps.Database.RecordOpenSSHConnection(connection.MetadataAlias()); err != nil &&
		s.deps.Log != nil {
		s.deps.Log.Warn("could not record recent connection", "error", err)
	}
}

func (s *session) runDial(profile *api.SSHProfile) error {
	if s.deps.Connections == nil {
		return errors.New("SSH support is unavailable")
	}
	lease, err := s.deps.Connections.Connect(
		profile, s.connectIO(nil), sshx.OwnerDial, false,
	)
	if err != nil {
		return err
	}
	connection := lease.Connection
	s.addOnClose(lease.Release)
	unsubscribe := connection.OnClose(func(reason string) {
		if reason == "" {
			reason = "The SSH transport closed unexpectedly."
		}
		s.ws.sendControl(api.ExitMessage{Op: "exit", Message: reason, Reason: "disconnected"})
		s.ws.close()
	})
	s.addOnClose(unsubscribe)
	s.recordSSHConnection(connection)
	s.ws.sendControl(api.ReadyMessage{
		Op: "ready", ConnID: connection.ID(),
		Host: connection.Host(), User: connection.User(),
	})
	<-s.closed
	return nil
}

func (s *session) runSSH(
	connect *api.ConnectMessage,
	recorder Recorder,
	handleLogging func(api.TerminalClientMessage) bool,
) error {
	if s.deps.Connections == nil {
		return errors.New("SSH support is unavailable")
	}
	terminal, err := s.deps.Connections.ConnectShell(
		connect.Profile.SSH, s.connectIO(recorder),
		connect.Cols, connect.Rows, "xterm-256color",
	)
	if err != nil {
		return err
	}
	connection := terminal.Lease.Connection
	stream := terminal.Stream
	releaseSession := func() {
		_ = stream.Close()
		terminal.Lease.Release()
		if s.deps.Forwards != nil &&
			s.deps.Connections.LeaseCount(
				connection.ID(), sshx.OwnerTerminal, sshx.OwnerDial,
			) == 0 {
			s.deps.Forwards.StopSessionForConnection(connection.ID())
		}
	}
	s.addOnClose(releaseSession)
	unsubscribeHealth := connection.OnHealth(func(state string) {
		s.ws.sendControl(api.NewConnectionHealth(state))
	})
	s.addOnClose(unsubscribeHealth)

	if s.deps.Forwards != nil {
		for _, forward := range connection.ConfigForwards() {
			if !s.isOpen() {
				return nil
			}
			_, _, startErr := s.deps.Forwards.StartConfig(api.ForwardRequest{
				ConnID: connection.ID(), Type: forward.Type,
				BindPort: forward.BindPort, TargetHost: forward.TargetHost,
				TargetPort: forward.TargetPort,
			})
			if startErr != nil {
				prefix := "?"
				if forward.Type != "" {
					prefix = strings.ToUpper(forward.Type[:1])
				}
				s.status(fmt.Sprintf(
					"forward -%s %d failed: %s",
					prefix, forward.BindPort, startErr.Error(),
				), false, recorder)
			}
		}
	}

	s.setWriteInput(func(data []byte) { _, _ = stream.Write(data) })
	s.control.SetHandlers(handleLogging, func(msg api.TerminalClientMessage) {
		if msg.Resize != nil {
			_ = stream.Resize(msg.Resize.Cols, msg.Resize.Rows)
		}
	})
	unsubscribeClose := connection.OnClose(func(reason string) {
		if reason == "" {
			reason = "The SSH transport closed unexpectedly."
		}
		recorder.End("disconnected")
		s.ws.sendControl(api.ExitMessage{Op: "exit", Message: reason, Reason: "disconnected"})
		s.ws.close()
	})
	s.addOnClose(unsubscribeClose)

	s.recordSSHConnection(connection)
	s.ws.sendControl(api.ReadyMessage{
		Op: "ready", ConnID: connection.ID(),
		Host: connection.Host(), User: connection.User(),
	})
	pumpErr := s.pump(stream, recorder)
	code, waitErr := stream.Wait()
	if !s.isOpen() {
		return nil
	}
	if pumpErr != nil && !errors.Is(pumpErr, io.EOF) {
		recorder.End("failed")
		s.ws.sendControl(api.ExitMessage{
			Op: "exit", Code: &code, Message: pumpErr.Error(), Reason: "failed",
		})
		return nil
	}
	if waitErr != nil {
		recorder.End("disconnected")
		s.ws.sendControl(api.ExitMessage{
			Op: "exit", Message: "The SSH channel closed without an exit status.",
			Reason: "disconnected",
		})
		return nil
	}
	recorder.End("completed")
	s.ws.sendControl(api.ExitMessage{Op: "exit", Code: &code, Reason: "completed"})
	return nil
}

func (s *session) runLocal(connect *api.ConnectMessage, recorder Recorder, handleLogging func(api.TerminalClientMessage) bool) error {
	if s.deps.SpawnLocalPty == nil {
		return errors.New("local terminals are unavailable")
	}
	pty, _, err := s.deps.SpawnLocalPty(connect.Profile.Local, connect.Cols, connect.Rows)
	if err != nil {
		return err
	}
	if !s.isOpen() {
		pty.Kill()
		return nil
	}
	s.setWriteInput(func(data []byte) { _, _ = pty.Write(data) })
	s.control.SetHandlers(handleLogging, func(msg api.TerminalClientMessage) {
		if msg.Resize != nil {
			_ = pty.Resize(msg.Resize.Cols, msg.Resize.Rows)
		}
	})
	s.addOnClose(func() { pty.Kill() })
	s.ws.sendControl(api.NewReady(fmt.Sprintf("local-%d", os.Getpid())))

	s.pump(pty, recorder)
	code := pty.Wait()
	recorder.End("completed")
	s.ws.sendControl(api.ExitMessage{Op: "exit", Code: &code, Reason: "completed"})
	return nil
}

func (s *session) runSerial(connect *api.ConnectMessage, recorder Recorder, handleLogging func(api.TerminalClientMessage) bool) error {
	if s.deps.SerialConnect == nil {
		return errors.New("serial terminals are unavailable")
	}
	profile := connect.Profile.Serial
	s.status(fmt.Sprintf("Opening %s at %d baud …", profile.Path, profile.BaudRate), true, recorder)
	transport, err := s.deps.SerialConnect(profile)
	if err != nil {
		return err
	}
	connID := "serial-" + s.newID()
	if profile.ProfileID != "" && s.deps.Database != nil {
		_ = s.deps.Database.RecordSavedHostConnection(profile.ProfileID)
	}
	s.attachTransport(transport, connID, recorder, handleLogging)
	return nil
}

func (s *session) runTelnet(connect *api.ConnectMessage, recorder Recorder, handleLogging func(api.TerminalClientMessage) bool) error {
	if s.deps.TelnetConnect == nil {
		return errors.New("telnet terminals are unavailable")
	}
	profile := connect.Profile.Telnet
	s.status(fmt.Sprintf("Connecting to %s:%d over Telnet …", profile.Host, profile.Port), true, recorder)
	transport, err := s.deps.TelnetConnect(profile, connect.Cols, connect.Rows)
	if err != nil {
		return err
	}
	connID := "telnet-" + s.newID()
	if profile.ProfileID != "" && s.deps.Database != nil {
		_ = s.deps.Database.RecordSavedHostConnection(profile.ProfileID)
	}
	s.attachTransport(transport, connID, recorder, handleLogging)
	return nil
}

func (s *session) newID() string {
	if s.deps.NewID != nil {
		return s.deps.NewID()
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (s *session) status(message string, transient bool, recorder Recorder) {
	recorder.System(message)
	s.ws.sendControl(api.NewStatus(message, transient))
}

// attachTransport mirrors attachTerminalTransport: byte pump plus exit
// classification — EOF is completed, a read error is failed.
func (s *session) attachTransport(transport TerminalTransport, connID string, recorder Recorder, handleLogging func(api.TerminalClientMessage) bool) {
	if !s.isOpen() {
		_ = transport.Close()
		return
	}
	s.setWriteInput(func(data []byte) { _, _ = transport.Write(data) })
	s.control.SetHandlers(handleLogging, func(msg api.TerminalClientMessage) {
		if msg.Resize != nil {
			_ = transport.Resize(msg.Resize.Cols, msg.Resize.Rows)
		}
	})
	s.addOnClose(func() { _ = transport.Close() })
	s.ws.sendControl(api.NewReady(connID))

	err := s.pump(transport, recorder)
	if err != nil && !errors.Is(err, io.EOF) && s.isOpen() {
		recorder.End("failed")
		s.ws.sendControl(api.ExitMessage{Op: "exit", Message: err.Error(), Reason: "failed"})
		return
	}
	recorder.End("completed")
	s.ws.sendControl(api.ExitMessage{Op: "exit", Reason: "completed"})
}

// pump copies transport output to the socket until EOF or error. The
// blocking sendBinary write is the flow control.
func (s *session) pump(source io.Reader, recorder Recorder) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := source.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			recorder.Output(chunk)
			s.ws.sendBinary(chunk)
		}
		if err != nil {
			return err
		}
	}
}
