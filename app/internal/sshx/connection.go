package sshx

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/user"
	pathpkg "path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/FloSch62/muxus/app/internal/api"
)

const (
	maxJumpDepth          = 8
	maxPasswordAttempts   = 3
	maxPassphraseAttempts = 3
)

var defaultIdentityNames = []string{
	"id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk",
}

type PromptInfo struct {
	Name         string
	Instructions string
	Host         string
	Prompts      []api.AuthPromptEntry
}

type HostKeyChallenge struct {
	Host        string
	Port        int
	KeyType     string
	Fingerprint string
	State       string
	Previous    string
	Hop         string
}

// ConnectIO is the interactive half of an SSH dial. Implementations normally
// bridge these calls to control messages on /ws/terminal.
type ConnectIO struct {
	Status  func(message string, transient bool)
	Prompt  func(PromptInfo) ([]string, error)
	HostKey func(HostKeyChallenge) (bool, error)
}

func (io ConnectIO) status(message string, transient bool) {
	if io.Status != nil {
		io.Status(message, transient)
	}
}

func (io ConnectIO) prompt(info PromptInfo) ([]string, error) {
	if io.Prompt == nil {
		return nil, errors.New("authentication prompt cannot be displayed")
	}
	return io.Prompt(info)
}

type ChainHop struct {
	Spec     HostSpec
	Resolved ResolvedTarget
	User     string
	Port     int
	HopLabel string
}

type Shell struct {
	session *ssh.Session
	stdin   io.WriteCloser
	reader  *io.PipeReader
	done    chan error
	once    sync.Once
}

func (s *Shell) Read(p []byte) (int, error)  { return s.reader.Read(p) }
func (s *Shell) Write(p []byte) (int, error) { return s.stdin.Write(p) }
func (s *Shell) Resize(cols, rows int) error { return s.session.WindowChange(rows, cols) }
func (s *Shell) Close() error {
	var err error
	s.once.Do(func() {
		_ = s.stdin.Close()
		err = s.session.Close()
		_ = s.reader.Close()
	})
	return err
}

func (s *Shell) Wait() (code int, err error) {
	err = <-s.done
	if err == nil {
		return 0, nil
	}
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitStatus(), nil
	}
	return 1, err
}

type Connection struct {
	id            string
	client        *ssh.Client
	jumpClients   []*ssh.Client
	profile       api.SSHProfile
	host          string
	port          int
	user          string
	muxKey        string
	metadataAlias string
	agentSocket   string

	mu              sync.Mutex
	configForwards  []api.ConfigForward
	health          string
	healthListeners map[int]func(string)
	closeListeners  map[int]func(string)
	nextListener    int
	closeReason     string
	closed          bool
	closeOnce       sync.Once

	sftpMu     sync.Mutex
	sftpClient *sftp.Client
}

func (c *Connection) ID() string              { return c.id }
func (c *Connection) Profile() api.SSHProfile { return c.profile }
func (c *Connection) Host() string            { return c.host }
func (c *Connection) Port() int               { return c.port }
func (c *Connection) User() string            { return c.user }
func (c *Connection) MuxKey() string          { return c.muxKey }
func (c *Connection) MetadataAlias() string   { return c.metadataAlias }

func (c *Connection) ConfigForwards() []api.ConfigForward {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]api.ConfigForward(nil), c.configForwards...)
}

func (c *Connection) mergeConfigForwards(requested []api.ConfigForward) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, forward := range requested {
		found := slices.ContainsFunc(c.configForwards, func(existing api.ConfigForward) bool {
			return existing.Type == forward.Type &&
				existing.BindPort == forward.BindPort &&
				existing.TargetHost == forward.TargetHost &&
				existing.TargetPort == forward.TargetPort
		})
		if !found {
			c.configForwards = append(c.configForwards, forward)
		}
	}
}

func (c *Connection) Health() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.health
}

func (c *Connection) setHealth(state string) {
	c.mu.Lock()
	if c.health == state || c.closed {
		c.mu.Unlock()
		return
	}
	c.health = state
	listeners := make([]func(string), 0, len(c.healthListeners))
	for _, listener := range c.healthListeners {
		listeners = append(listeners, listener)
	}
	c.mu.Unlock()
	for _, listener := range listeners {
		listener(state)
	}
}

func (c *Connection) OnHealth(listener func(string)) func() {
	c.mu.Lock()
	id := c.nextListener
	c.nextListener++
	c.healthListeners[id] = listener
	state := c.health
	c.mu.Unlock()
	if state == "suspect" {
		go listener(state)
	}
	return func() {
		c.mu.Lock()
		delete(c.healthListeners, id)
		c.mu.Unlock()
	}
}

func (c *Connection) OnClose(listener func(string)) func() {
	c.mu.Lock()
	if c.closed {
		reason := c.closeReason
		c.mu.Unlock()
		go listener(reason)
		return func() {}
	}
	id := c.nextListener
	c.nextListener++
	c.closeListeners[id] = listener
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.closeListeners, id)
		c.mu.Unlock()
	}
}

func (c *Connection) notifyClosed(reason string) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if reason != "" {
		c.closeReason = reason
	}
	listeners := make([]func(string), 0, len(c.closeListeners))
	for _, listener := range c.closeListeners {
		listeners = append(listeners, listener)
	}
	c.closeListeners = map[int]func(string){}
	c.healthListeners = map[int]func(string){}
	c.mu.Unlock()
	for _, listener := range listeners {
		listener(c.closeReason)
	}
}

func (c *Connection) Close() {
	c.closeOnce.Do(func() {
		c.sftpMu.Lock()
		if c.sftpClient != nil {
			_ = c.sftpClient.Close()
			c.sftpClient = nil
		}
		c.sftpMu.Unlock()
		_ = c.client.Close()
		for i := len(c.jumpClients) - 1; i >= 0; i-- {
			_ = c.jumpClients[i].Close()
		}
	})
}

func (c *Connection) SFTP() (*sftp.Client, error) {
	c.sftpMu.Lock()
	defer c.sftpMu.Unlock()
	if c.sftpClient != nil {
		return c.sftpClient, nil
	}
	client, err := sftp.NewClient(c.client)
	if err != nil {
		return nil, err
	}
	c.sftpClient = client
	return client, nil
}

func (c *Connection) DialTunnel(host string, port int) (net.Conn, error) {
	return c.client.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}

func (c *Connection) ListenRemote(port int) (net.Listener, error) {
	return c.client.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

type sessionProbe struct{ client *ssh.Client }

func (p sessionProbe) Exec(command string) (io.ReadCloser, error) {
	session, err := p.client.NewSession()
	if err != nil {
		return nil, err
	}
	reader, writer := io.Pipe()
	session.Stdout = writer
	session.Stderr = writer
	if err := session.Start(command); err != nil {
		_ = session.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	go func() {
		_ = session.Wait()
		_ = writer.Close()
		_ = session.Close()
	}()
	return reader, nil
}

type integrationSFTP struct{ client *sftp.Client }

func (s integrationSFTP) Stat(remotePath string) (os.FileInfo, error) {
	return s.client.Stat(remotePath)
}
func (s integrationSFTP) Mkdir(remotePath string) error { return s.client.Mkdir(remotePath) }
func (s integrationSFTP) WriteFile(remotePath string, content []byte) error {
	file, err := s.client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func (c *Connection) Shell(cols, rows int, term string) (*Shell, error) {
	command, _ := PrepareIntegratedShell(
		sessionProbe{client: c.client},
		func() (IntegrationSftp, error) {
			client, err := c.SFTP()
			return integrationSFTP{client: client}, err
		},
	)
	session, err := c.client.NewSession()
	if err != nil {
		return nil, err
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1}
	if err := session.RequestPty(term, rows, cols, modes); err != nil {
		_ = session.Close()
		return nil, err
	}
	if c.agentSocket != "" {
		_ = agent.RequestAgentForwarding(session)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	reader, writer := io.Pipe()
	session.Stdout = writer
	session.Stderr = writer
	if command == "" {
		err = session.Shell()
	} else {
		err = session.Start(command)
	}
	if err != nil {
		_ = stdin.Close()
		_ = session.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	shell := &Shell{session: session, stdin: stdin, reader: reader, done: make(chan error, 1)}
	go func() {
		waitErr := session.Wait()
		_ = writer.Close()
		shell.done <- waitErr
		close(shell.done)
	}()
	return shell, nil
}

type MuxedLease struct {
	*Lease[*Connection]
	Reused bool
}

type TerminalShell struct {
	Lease     *MuxedLease
	Stream    *Shell
	Transport string
}

type pendingDial struct {
	done chan struct{}
	conn *Connection
	err  error
}

type ManagerOptions struct {
	KnownHosts  *KnownHostsStore
	LoadConfig  func() *ConfigDocument
	DialTimeout func(network, address string, timeout time.Duration) (net.Conn, error)
}

type ConnectionManager struct {
	log         *slog.Logger
	registry    *LeaseRegistry[*Connection]
	knownHosts  *KnownHostsStore
	loadConfig  func() *ConfigDocument
	dialTimeout func(network, address string, timeout time.Duration) (net.Conn, error)

	mu      sync.Mutex
	pending map[string]*pendingDial
}

func NewConnectionManager(log *slog.Logger, options ManagerOptions) *ConnectionManager {
	if log == nil {
		log = slog.Default()
	}
	knownHosts := options.KnownHosts
	if knownHosts == nil {
		knownHosts = NewKnownHostsStore("", "")
	}
	loadConfig := options.LoadConfig
	if loadConfig == nil {
		loadConfig = func() *ConfigDocument { return LoadConfigDocument(DefaultConfigPath()) }
	}
	dialTimeout := options.DialTimeout
	if dialTimeout == nil {
		dialTimeout = net.DialTimeout
	}
	return &ConnectionManager{
		log: log, registry: NewLeaseRegistry[*Connection](),
		knownHosts: knownHosts, loadConfig: loadConfig,
		dialTimeout: dialTimeout,
		pending:     map[string]*pendingDial{},
	}
}

func (m *ConnectionManager) Acquire(id string, owner LeaseOwner) *Lease[*Connection] {
	return m.registry.Acquire(id, owner)
}

func (m *ConnectionManager) AcquireForward(id string) (*Connection, func(), bool) {
	lease := m.registry.Acquire(id, OwnerForward)
	if lease == nil {
		return nil, nil, false
	}
	return lease.Connection, lease.Release, true
}

func (m *ConnectionManager) LeaseCount(id string, owners ...LeaseOwner) int {
	return m.registry.LeaseCount(id, owners...)
}

func (m *ConnectionManager) List() []api.ConnectionInfo {
	connections := m.registry.List()
	out := make([]api.ConnectionInfo, 0, len(connections))
	for _, connection := range connections {
		out = append(out, api.ConnectionInfo{
			ID: connection.id, Target: connection.profile.Target,
			Host: connection.host, Port: connection.port, User: connection.user,
			MetadataAlias: connection.metadataAlias,
		})
	}
	return out
}

func (m *ConnectionManager) CloseAll() { m.registry.CloseAll() }

func (m *ConnectionManager) acquireShared(key string, owner LeaseOwner) *MuxedLease {
	candidates := m.registry.List()
	slices.SortStableFunc(candidates, func(a, b *Connection) int {
		return m.registry.LeaseCount(a.ID()) - m.registry.LeaseCount(b.ID())
	})
	for _, connection := range candidates {
		if connection.muxKey != key || connection.Health() != "healthy" {
			continue
		}
		if lease := m.registry.Acquire(connection.ID(), owner); lease != nil {
			return &MuxedLease{Lease: lease, Reused: true}
		}
	}
	return nil
}

func (m *ConnectionManager) Connect(
	profile *api.SSHProfile,
	connectIO ConnectIO,
	owner LeaseOwner,
	freshTransport bool,
) (*MuxedLease, error) {
	if owner == "" {
		owner = OwnerTerminal
	}
	doc := m.loadConfig()
	chain, err := BuildChain(doc, profile)
	if err != nil {
		return nil, err
	}
	key := MuxKey(chain)
	target := chain[len(chain)-1]
	label := fmt.Sprintf("%s@%s:%d", target.User, target.Resolved.Hostname, target.Port)
	if !freshTransport {
		if lease := m.acquireShared(key, owner); lease != nil {
			lease.Connection.mergeConfigForwards(target.Resolved.Forwards)
			connectIO.status("Reusing the SSH connection to "+label+" (multiplexed).", true)
			return lease, nil
		}
		m.mu.Lock()
		pending := m.pending[key]
		m.mu.Unlock()
		if pending != nil {
			connectIO.status("Waiting for the SSH connection to "+label+" …", true)
			<-pending.done
			if pending.err != nil {
				return nil, pending.err
			}
			if lease := m.registry.Acquire(pending.conn.ID(), owner); lease != nil {
				lease.Connection.mergeConfigForwards(target.Resolved.Forwards)
				return &MuxedLease{Lease: lease, Reused: true}, nil
			}
		}
	}

	pending := &pendingDial{done: make(chan struct{})}
	if !freshTransport {
		m.mu.Lock()
		if existing := m.pending[key]; existing != nil {
			m.mu.Unlock()
			<-existing.done
			if existing.err != nil {
				return nil, existing.err
			}
			lease := m.registry.Acquire(existing.conn.ID(), owner)
			if lease == nil {
				return m.Connect(profile, connectIO, owner, false)
			}
			return &MuxedLease{Lease: lease, Reused: true}, nil
		}
		m.pending[key] = pending
		m.mu.Unlock()
	}
	lease, dialErr := m.dialChain(doc, chain, *profile, connectIO, owner, key)
	if !freshTransport {
		pending.err = dialErr
		if lease != nil {
			pending.conn = lease.Connection
		}
		close(pending.done)
		m.mu.Lock()
		if m.pending[key] == pending {
			delete(m.pending, key)
		}
		m.mu.Unlock()
	}
	if dialErr != nil {
		return nil, dialErr
	}
	return &MuxedLease{Lease: lease, Reused: false}, nil
}

func (m *ConnectionManager) ConnectShell(
	profile *api.SSHProfile,
	connectIO ConnectIO,
	cols, rows int,
	term string,
) (*TerminalShell, error) {
	lease, err := m.Connect(profile, connectIO, OwnerTerminal, false)
	if err != nil {
		return nil, err
	}
	stream, err := lease.Connection.Shell(cols, rows, term)
	if err == nil {
		transport := "new"
		if lease.Reused {
			transport = "shared"
		}
		return &TerminalShell{Lease: lease, Stream: stream, Transport: transport}, nil
	}
	lease.Release()
	if !lease.Reused {
		return nil, err
	}
	m.log.Info("shared ssh transport refused a session", "host", lease.Connection.host, "error", err)
	connectIO.status("The shared SSH connection refused another session — opening a dedicated one …", true)
	dedicated, err := m.Connect(profile, connectIO, OwnerTerminal, true)
	if err != nil {
		return nil, err
	}
	stream, err = dedicated.Connection.Shell(cols, rows, term)
	if err != nil {
		dedicated.Release()
		return nil, err
	}
	return &TerminalShell{Lease: dedicated, Stream: stream, Transport: "overflow"}, nil
}

func (m *ConnectionManager) dialChain(
	doc *ConfigDocument,
	chain []ChainHop,
	profile api.SSHProfile,
	connectIO ConnectIO,
	owner LeaseOwner,
	key string,
) (*Lease[*Connection], error) {
	clients := []*ssh.Client{}
	var transport net.Conn
	var agentSocket string
	for index, hop := range chain {
		via := ""
		if index > 0 {
			via = " via " + chain[index-1].Spec.Host
		}
		connectIO.status(
			fmt.Sprintf("Connecting to %s@%s:%d%s …", hop.User, hop.Resolved.Hostname, hop.Port, via),
			true,
		)
		client, usedAgent, err := m.dial(hop, transport, connectIO)
		if err != nil {
			for i := len(clients) - 1; i >= 0; i-- {
				_ = clients[i].Close()
			}
			return nil, err
		}
		clients = append(clients, client)
		if usedAgent != "" && hop.Resolved.ForwardAgent {
			agentSocket = usedAgent
		}
		if nextIndex := index + 1; nextIndex < len(chain) {
			next := chain[nextIndex]
			transport, err = client.Dial(
				"tcp", net.JoinHostPort(next.Resolved.Hostname, strconv.Itoa(next.Port)),
			)
			if err != nil {
				for i := len(clients) - 1; i >= 0; i-- {
					_ = clients[i].Close()
				}
				return nil, fmt.Errorf(
					"jump host could not reach %s:%d: %w",
					next.Resolved.Hostname, next.Port, err,
				)
			}
		}
	}

	target := chain[len(chain)-1]
	id, err := gonanoid.Generate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-", 10)
	if err != nil {
		id = fmt.Sprintf("ssh-%d", time.Now().UnixNano())
	}
	metadataAlias := ""
	useConfig := profile.UseConfig == nil || *profile.UseConfig
	if useConfig {
		metadataAlias = FindMetadataAlias(doc, target.Spec.Host)
	}
	connection := &Connection{
		id: id, client: clients[len(clients)-1],
		jumpClients: clients[:len(clients)-1], profile: profile,
		host: target.Resolved.Hostname, port: target.Port, user: target.User,
		muxKey: key, metadataAlias: metadataAlias, agentSocket: agentSocket,
		configForwards: append([]api.ConfigForward(nil), target.Resolved.Forwards...),
		health:         "healthy", healthListeners: map[int]func(string){},
		closeListeners: map[int]func(string){},
	}
	if agentSocket != "" {
		_ = agent.ForwardToRemote(connection.client, agentSocket)
	}
	lease, err := m.registry.Register(connection, owner)
	if err != nil {
		connection.Close()
		return nil, err
	}
	go m.watchConnection(connection, target)
	return lease, nil
}

func (m *ConnectionManager) watchConnection(connection *Connection, target ChainHop) {
	interval := 15 * time.Second
	if target.Resolved.ServerAliveInterval != nil && *target.Resolved.ServerAliveInterval > 0 {
		interval = time.Duration(*target.Resolved.ServerAliveInterval * float64(time.Second))
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				done := make(chan error, 1)
				go func() {
					_, _, err := connection.client.SendRequest("keepalive@openssh.com", true, nil)
					done <- err
				}()
				select {
				case err := <-done:
					if err != nil {
						connection.setHealth("suspect")
					} else {
						connection.setHealth("healthy")
					}
				case <-time.After(interval):
					connection.setHealth("suspect")
				}
			case <-stop:
				return
			}
		}
	}()
	err := connection.client.Wait()
	close(stop)
	reason := connection.closeReason
	if reason == "" && err != nil {
		reason = friendlyConnectError(err, target).Error()
	}
	connection.notifyClosed(reason)
	m.registry.MarkClosed(connection)
	for _, jump := range connection.jumpClients {
		_ = jump.Close()
	}
}

func (m *ConnectionManager) dial(
	hop ChainHop,
	transport net.Conn,
	connectIO ConnectIO,
) (*ssh.Client, string, error) {
	var err error
	if transport == nil {
		if hop.Resolved.ProxyCommand != "" {
			command := ExpandProxyCommand(hop.Resolved.ProxyCommand, ProxyTokens{
				Hostname: hop.Resolved.Hostname, OriginalHost: hop.Spec.Host,
				Port: hop.Port, User: hop.User,
			})
			transport, err = OpenProxyCommand(command)
		} else {
			timeout := 20 * time.Second
			if hop.Resolved.ConnectTimeout != nil {
				timeout = time.Duration(*hop.Resolved.ConnectTimeout * float64(time.Second))
			}
			transport, err = m.dialTimeout(
				"tcp", net.JoinHostPort(hop.Resolved.Hostname, strconv.Itoa(hop.Port)), timeout,
			)
		}
		if err != nil {
			return nil, "", friendlyConnectError(err, hop)
		}
	}

	methods, cleanup, agentSocket, err := authMethods(hop, connectIO)
	if err != nil {
		_ = transport.Close()
		return nil, "", err
	}
	defer cleanup()
	config := &ssh.ClientConfig{
		User: hop.User, Auth: methods,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			verdict := m.knownHosts.Verify(hop.Resolved.Hostname, hop.Port, key)
			if verdict.State == KnownHostOk {
				return nil
			}
			if verdict.State == KnownHostRevoked {
				connectIO.status(
					fmt.Sprintf("HOST KEY REVOKED for %s — remove the @revoked entry from known_hosts if this is intentional.", hop.Resolved.Hostname),
					false,
				)
				return errors.New("host key revoked")
			}
			state := "new"
			if verdict.State == KnownHostChanged {
				state = "mismatch"
			}
			if connectIO.HostKey == nil {
				return errors.New("host key is not trusted")
			}
			accepted, promptErr := connectIO.HostKey(HostKeyChallenge{
				Host: hop.Resolved.Hostname, Port: hop.Port,
				KeyType: key.Type(), Fingerprint: ssh.FingerprintSHA256(key),
				State: state, Previous: verdict.Previous, Hop: hop.HopLabel,
			})
			if promptErr != nil || !accepted {
				return errors.New("host key rejected")
			}
			return m.knownHosts.Record(hop.Resolved.Hostname, hop.Port, key)
		},
		Timeout: 20 * time.Second,
	}
	if deadline, ok := configDeadline(hop); ok {
		_ = transport.SetDeadline(deadline)
		defer transport.SetDeadline(time.Time{})
	}
	conn, chans, reqs, err := ssh.NewClientConn(
		transport, net.JoinHostPort(hop.Resolved.Hostname, strconv.Itoa(hop.Port)), config,
	)
	if err != nil {
		_ = transport.Close()
		return nil, "", friendlyConnectError(err, hop)
	}
	return ssh.NewClient(conn, chans, reqs), agentSocket, nil
}

func configDeadline(hop ChainHop) (time.Time, bool) {
	timeout := 20 * time.Second
	if hop.Resolved.ConnectTimeout != nil {
		timeout = time.Duration(*hop.Resolved.ConnectTimeout * float64(time.Second))
	}
	if timeout <= 0 {
		return time.Time{}, false
	}
	return time.Now().Add(timeout), true
}

func authMethods(hop ChainHop, connectIO ConnectIO) ([]ssh.AuthMethod, func(), string, error) {
	methods := []ssh.AuthMethod{}
	cleanups := []func(){}
	cleanup := func() {
		for _, closeFn := range cleanups {
			closeFn()
		}
	}
	agentSocket := AgentSocket()
	if !hop.Resolved.PasswordOnly && agentSocket != "" && !hop.Resolved.IdentitiesOnly {
		if conn, err := net.Dial("unix", agentSocket); err == nil {
			keyring := agent.NewClient(conn)
			methods = append(methods, ssh.PublicKeysCallback(keyring.Signers))
			cleanups = append(cleanups, func() { _ = conn.Close() })
		}
	}

	if !hop.Resolved.PasswordOnly {
		files := append([]string(nil), hop.Resolved.IdentityFiles...)
		explicit := len(files) > 0
		if !explicit {
			files = defaultIdentityFiles()
		}
		signers := make([]ssh.Signer, 0, len(files))
		for _, file := range files {
			signer, err := readPrivateSigner(file, explicit, agentSocket != "", hop, connectIO)
			if err != nil {
				cleanup()
				return nil, func() {}, "", err
			}
			if signer != nil {
				signers = append(signers, signer)
			}
		}
		certSigners := []ssh.Signer{}
		for _, certFile := range hop.Resolved.CertificateFiles {
			content, err := os.ReadFile(certFile)
			if err != nil {
				connectIO.status("certificate file "+certFile+" not found — skipping", false)
				continue
			}
			certificate, err := ParseOpenSshCertificate(content)
			if err != nil {
				connectIO.status(
					"could not load "+filepath.Base(certFile)+": "+err.Error(), false,
				)
				continue
			}
			found := false
			for _, signer := range signers {
				if !CertificateMatchesKey(certificate, signer.PublicKey()) {
					continue
				}
				certSigner, err := CertifiedKey(
					signer, certificate, CertificateAlgorithms(certificate)[0],
				)
				if err == nil {
					certSigners = append(certSigners, certSigner)
					found = true
					break
				}
			}
			if !found {
				connectIO.status(
					"certificate "+certFile+" has no matching identity file — skipping", false,
				)
			}
		}
		if len(certSigners) > 0 {
			methods = append(methods, ssh.PublicKeys(certSigners...))
		}
		if len(signers) > 0 {
			methods = append(methods, ssh.PublicKeys(signers...))
		}
	}

	label := hop.HopLabel
	if label == "" {
		label = hop.Spec.Host
	}
	methods = append(methods, ssh.KeyboardInteractive(func(
		user, instruction string, questions []string, echos []bool,
	) ([]string, error) {
		prompts := make([]api.AuthPromptEntry, len(questions))
		for index, question := range questions {
			echo := false
			if index < len(echos) {
				echo = echos[index]
			}
			prompts[index] = api.AuthPromptEntry{Prompt: question, Echo: echo}
		}
		return connectIO.prompt(PromptInfo{
			Instructions: instruction, Host: label, Prompts: prompts,
		})
	}))
	for attempt := 1; attempt <= maxPasswordAttempts; attempt++ {
		attempt := attempt
		methods = append(methods, ssh.PasswordCallback(func() (string, error) {
			prompt := fmt.Sprintf("%s@%s's password", hop.User, label)
			if attempt > 1 {
				prompt = "Permission denied, please try again. Password"
			}
			answers, err := connectIO.prompt(PromptInfo{
				Host:    label,
				Prompts: []api.AuthPromptEntry{{Prompt: prompt, Echo: false}},
			})
			if err != nil {
				return "", err
			}
			if len(answers) == 0 {
				return "", nil
			}
			return answers[0], nil
		}))
	}
	return methods, cleanup, agentSocket, nil
}

func readPrivateSigner(
	file string,
	explicit, agentAvailable bool,
	hop ChainHop,
	connectIO ConnectIO,
) (ssh.Signer, error) {
	content, err := os.ReadFile(file)
	if err != nil {
		if explicit {
			connectIO.status("identity file "+file+" not found — skipping", false)
		}
		return nil, nil
	}
	signer, err := ParseSshPrivateKey(content, nil)
	if err == nil {
		return signer, nil
	}
	encrypted := strings.Contains(strings.ToLower(err.Error()), "passphrase") ||
		strings.Contains(strings.ToLower(err.Error()), "encrypted")
	if !encrypted {
		connectIO.status("could not load "+filepath.Base(file)+": "+err.Error(), false)
		return nil, nil
	}
	if !explicit && agentAvailable {
		return nil, nil
	}
	label := hop.HopLabel
	if label == "" {
		label = hop.Spec.Host
	}
	for attempt := 0; attempt < maxPassphraseAttempts; attempt++ {
		prefix := ""
		if attempt > 0 {
			prefix = "Bad passphrase, try again. "
		}
		answers, promptErr := connectIO.prompt(PromptInfo{
			Host: label,
			Prompts: []api.AuthPromptEntry{{
				Prompt: prefix + "Passphrase for " + filepath.Base(file), Echo: false,
			}},
		})
		if promptErr != nil {
			return nil, promptErr
		}
		if len(answers) == 0 || answers[0] == "" {
			return nil, nil
		}
		signer, err = ParseSshPrivateKey(content, []byte(answers[0]))
		if err == nil {
			return signer, nil
		}
	}
	connectIO.status("could not load "+filepath.Base(file)+": "+err.Error(), false)
	return nil, nil
}

func defaultIdentityFiles() []string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".ssh")
	files := []string{}
	for _, name := range defaultIdentityNames {
		file := filepath.Join(dir, name)
		if _, err := os.Stat(file); err == nil {
			files = append(files, file)
		}
	}
	return files
}

func BuildChain(doc *ConfigDocument, profile *api.SSHProfile) ([]ChainHop, error) {
	chain := []ChainHop{}
	visited := map[string]bool{}
	var walk func(HostSpec, bool, int) error
	walk = func(spec HostSpec, final bool, depth int) error {
		if depth > maxJumpDepth {
			return errors.New("ProxyJump chain too deep")
		}
		if visited[spec.Host] {
			return fmt.Errorf("ProxyJump cycle detected at %q", spec.Host)
		}
		visited[spec.Host] = true
		fromConfig := !final || profile.UseConfig == nil || *profile.UseConfig
		resolved := directSettings(spec.Host)
		if fromConfig {
			resolved = ResolveHost(doc, spec.Host)
		}
		userName := spec.User
		if final && profile.User != "" {
			userName = profile.User
		}
		if userName == "" {
			userName = resolved.User
		}
		if userName == "" {
			userName = localUsername()
		}
		if final {
			if profile.IdentityFiles != nil {
				resolved.IdentityFiles = make([]string, 0, len(profile.IdentityFiles))
				for _, file := range profile.IdentityFiles {
					resolved.IdentityFiles = append(
						resolved.IdentityFiles,
						ExpandIdentityPath(file, resolved.Hostname, userName),
					)
				}
			}
			if profile.IdentitiesOnly != nil {
				resolved.IdentitiesOnly = *profile.IdentitiesOnly
			}
			if profile.ForwardAgent != nil {
				resolved.ForwardAgent = *profile.ForwardAgent
			}
			if profile.ProxyJump != nil {
				resolved.ProxyJump = append([]string(nil), profile.ProxyJump...)
				resolved.ProxyCommand = ""
			}
			if profile.PasswordOnly != nil {
				resolved.PasswordOnly = *profile.PasswordOnly
			}
		}
		for _, jump := range resolved.ProxyJump {
			if err := walk(ParseHostSpec(jump), false, depth+1); err != nil {
				return err
			}
		}
		port := spec.Port
		if final && profile.Port != 0 {
			port = profile.Port
		}
		if port == 0 {
			port = resolved.Port
		}
		label := spec.Host
		if final {
			label = ""
		}
		chain = append(chain, ChainHop{
			Spec: spec, Resolved: resolved, User: userName, Port: port, HopLabel: label,
		})
		return nil
	}
	if err := walk(ParseHostSpec(profile.Target), true, 0); err != nil {
		return nil, err
	}
	return chain, nil
}

func directSettings(hostname string) ResolvedTarget {
	return ResolvedTarget{ResolvedHostSettings: api.ResolvedHostSettings{
		Hostname: hostname, Port: 22, IdentityFiles: []string{},
		CertificateFiles: []string{}, ProxyJump: []string{}, Forwards: []api.ConfigForward{},
	}}
}

func localUsername() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		if slash := strings.LastIndexByte(current.Username, '\\'); slash >= 0 {
			return current.Username[slash+1:]
		}
		return current.Username
	}
	if value := os.Getenv("USER"); value != "" {
		return value
	}
	return os.Getenv("USERNAME")
}

func MuxKey(chain []ChainHop) string {
	parts := make([]string, 0, len(chain)+1)
	if len(chain) > 0 && chain[0].Resolved.ProxyCommand != "" {
		command := ExpandProxyCommand(chain[0].Resolved.ProxyCommand, ProxyTokens{
			Hostname: chain[0].Resolved.Hostname, OriginalHost: chain[0].Spec.Host,
			Port: chain[0].Port, User: chain[0].User,
		})
		parts = append(parts, "proxy("+command+")")
	}
	for _, hop := range chain {
		forward := "no"
		if hop.Resolved.ForwardAgent {
			forward = "yes"
		}
		parts = append(parts, fmt.Sprintf(
			"%s@%s:%d;agentForward=%s",
			hop.User, hop.Resolved.Hostname, hop.Port, forward,
		))
	}
	return strings.Join(parts, " -> ")
}

func FindMetadataAlias(doc *ConfigDocument, requestedHost string) string {
	for _, entry := range ListHosts(doc) {
		if slices.Contains(entry.Aliases, requestedHost) {
			return requestedHost
		}
	}
	return ""
}

func friendlyConnectError(err error, hop ChainHop) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	where := net.JoinHostPort(hop.Resolved.Hostname, strconv.Itoa(hop.Port))
	switch {
	case strings.Contains(message, "connection refused"):
		return fmt.Errorf("connection refused by %s — is sshd running?", where)
	case strings.Contains(message, "no such host"), strings.Contains(message, "server misbehaving"):
		return fmt.Errorf("could not resolve host %s", hop.Resolved.Hostname)
	case strings.Contains(strings.ToLower(message), "timeout"):
		return fmt.Errorf("connection to %s timed out", where)
	case strings.Contains(message, "unable to authenticate"):
		return fmt.Errorf("authentication to %s failed", where)
	default:
		return err
	}
}

// RemotePathJoin is shared by the SFTP route implementation.
func RemotePathJoin(base, name string) string { return pathpkg.Join(base, name) }
