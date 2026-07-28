// Command muxus is the single binary behind both deployment modes: with no
// arguments it launches the desktop shell; `muxus serve` runs the
// headless server for browser use.
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/pkg/browser"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/forwards"
	"github.com/FloSch62/muxus/app/internal/frontend"
	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/localpty"
	"github.com/FloSch62/muxus/app/internal/paths"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/serialx"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/server/routes"
	"github.com/FloSch62/muxus/app/internal/server/ws"
	"github.com/FloSch62/muxus/app/internal/shell"
	"github.com/FloSch62/muxus/app/internal/sshx"
	"github.com/FloSch62/muxus/app/internal/telnetx"
)

func main() {
	args := os.Args[1:]
	mode := "shell"
	if len(args) > 0 && args[0] == "serve" {
		mode = "serve"
		args = args[1:]
	}

	switch mode {
	case "serve":
		if err := runServe(args); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		if err := runShell(args); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}

type flagMap map[string]string

type forwardConnections struct{ manager *sshx.ConnectionManager }

func (a forwardConnections) AcquireForward(id string) (forwards.Conn, func(), bool) {
	connection, release, ok := a.manager.AcquireForward(id)
	if !ok {
		return nil, nil, false
	}
	return connection, release, true
}

// parseFlags mirrors the Node server's tolerant --key value / --key=value
// parsing.
func parseFlags(args []string) flagMap {
	out := flagMap{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if len(a) < 3 || a[:2] != "--" {
			continue
		}
		if eq := indexByte(a, '='); eq > 2 {
			out[a[2:eq]] = a[eq+1:]
			continue
		}
		if i+1 < len(args) && (len(args[i+1]) < 2 || args[i+1][:2] != "--") {
			out[a[2:]] = args[i+1]
			i++
		} else {
			out[a[2:]] = "true"
		}
	}
	return out
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func registerAll(ctx *server.Context) func(r chi.Router) {
	wsDeps := &ws.Deps{
		SpawnLocalPty: func(profile *api.LocalProfile, cols, rows int) (ws.LocalPty, string, error) {
			pty, err := localpty.Spawn(profile, cols, rows)
			if err != nil {
				return nil, "", err
			}
			return pty, pty.Shell, nil
		},
		TelnetConnect: func(profile *api.TelnetProfile, cols, rows int) (ws.TerminalTransport, error) {
			transport, err := telnetx.Connect(profile, cols, rows)
			if err != nil {
				return nil, err
			}
			return transport, nil
		},
		SerialConnect: func(profile *api.SerialProfile) (ws.TerminalTransport, error) {
			transport, err := serialx.Connect(profile)
			if err != nil {
				return nil, err
			}
			return transport, nil
		},
		NewID: func() string {
			return gonanoid.MustGenerate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-", 10)
		},
		Connections: ctx.Connections,
		Forwards:    ctx.Forwards,
		Database:    ctx.Database,
		NewRecorder: func(profile api.SessionProfile, title string) ws.Recorder {
			return ws.NewSessionRecorder(ctx.Database, ctx.History, ctx.Log, profile, title)
		},
		Log: slog.Default(),
	}
	return func(r chi.Router) {
		routes.RegisterAppRoutes(r, ctx)
		routes.RegisterSSHRoutes(r, ctx.Database)
		routes.RegisterSFTPRoutes(r, ctx)
		routes.RegisterForwardRoutes(r, ctx)
		routes.RegisterTunnelRoutes(r, ctx.Database)
		routes.RegisterWorkspaceRoutes(r, ctx.Database)
		routes.RegisterTerminalSnapshotRoutes(r, ctx.Database)
		routes.RegisterSerialRoutes(r)
		routes.RegisterProfileRoutes(r, ctx.Database)
		routes.RegisterHostOrderRoutes(r, ctx.Database)
		routes.RegisterSessionHistoryRoutes(r, ctx)
		ws.RegisterTerminalSocket(r, ctx, wsDeps)
		ws.RegisterSFTPLeaseSocket(r, ctx)
	}
}

func openContext(cfg server.Config) (*server.Context, error) {
	db, err := persist.Open(cfg.DatabasePath)
	if err != nil {
		return nil, err
	}
	settings, err := db.SessionHistorySettings()
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	historyRoot := cfg.HistoryPath
	if historyRoot == "" {
		historyRoot = settings.StorageLocation
	}
	if historyRoot == "" && cfg.DatabasePath != ":memory:" {
		historyRoot = filepath.Join(filepath.Dir(cfg.DatabasePath), "history")
	}
	hadLegacy, err := db.HasLegacySessionHistory()
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	legacyPath := ""
	if hadLegacy {
		legacyPath = cfg.DatabasePath
	}
	historyStore, err := history.Open(history.Options{
		Root: historyRoot, Settings: settings, LegacyDatabasePath: legacyPath,
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := db.FinalizeSessionHistorySeparation(hadLegacy); err != nil {
		_ = historyStore.Close()
		_ = db.Close()
		return nil, err
	}
	if _, err := db.PruneTerminalSnapshots(3600); err != nil {
		_ = historyStore.Close()
		_ = db.Close()
		return nil, err
	}
	log := slog.Default()
	connections := sshx.NewConnectionManager(log, connectionManagerOptions())
	ctx := &server.Context{
		Config: cfg, Log: log, Database: db, History: historyStore,
		Connections: connections,
	}
	ctx.Forwards = forwards.NewManager(forwardConnections{manager: connections}, log)
	return ctx, nil
}

func connectionManagerOptions() sshx.ManagerOptions {
	raw := os.Getenv("MUXUS_DEMO_HOSTMAP")
	if raw == "" {
		return sshx.ManagerOptions{}
	}
	var hostMap map[string]int
	if json.Unmarshal([]byte(raw), &hostMap) != nil {
		return sshx.ManagerOptions{}
	}
	return sshx.ManagerOptions{
		DialTimeout: func(network, address string, timeout time.Duration) (net.Conn, error) {
			host, _, err := net.SplitHostPort(address)
			if err == nil {
				if port := hostMap[host]; port >= 1 && port <= 65535 {
					address = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
				}
			}
			return net.DialTimeout(network, address, timeout)
		},
	}
}

func closeContext(ctx *server.Context) error {
	ctx.Forwards.StopAll()
	ctx.Connections.CloseAll()
	if err := ctx.History.Close(); err != nil {
		_ = ctx.Database.Close()
		return err
	}
	return ctx.Database.Close()
}

func runServe(args []string) error {
	flags := parseFlags(args)

	dev := os.Getenv("NODE_ENV") != "production" && os.Getenv("MUXUS_DEV") == "1"
	devToken := ""
	if dev {
		// The Vite client can't learn a random token at startup; the server
		// still only listens on 127.0.0.1.
		devToken = "dev"
	}

	overrides := server.Overrides{DevToken: devToken}
	portRaw := flags["port"]
	if portRaw == "" {
		portRaw = os.Getenv("PORT")
	}
	if portRaw != "" {
		port, err := server.ParsePort(portRaw)
		if err != nil {
			return err
		}
		overrides.Port = &port
	}
	openBrowser := !dev && flags["no-open"] != "true" && os.Getenv("MUXUS_NO_OPEN") != "1"
	overrides.OpenBrowser = &openBrowser
	if historyPath := flags["history-path"]; historyPath != "" {
		overrides.HistoryPath = historyPath
	} else if env := os.Getenv("MUXUS_HISTORY_PATH"); env != "" {
		overrides.HistoryPath = env
	}

	cfg := server.ResolveConfig(overrides)
	cfg.StaticFS = frontend.Assets()
	ctx, err := openContext(cfg)
	if err != nil {
		return err
	}
	running, err := server.Start(cfg, registerAll(ctx), func() error {
		return closeContext(ctx)
	})
	if err != nil {
		_ = closeContext(ctx)
		return err
	}
	// The registration context needs the same config the server resolved;
	// Start builds its own logger, so mirror it once wired subsystems need it.

	fmt.Printf("muxus listening on %s\n", running.URL)
	if cfg.OpenBrowser {
		_ = browser.OpenURL(running.BrowserURL)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	return running.Close()
}

func runShell(args []string) error {
	flags := parseFlags(args)
	port := 0
	openBrowser := false
	prettyLogs := os.Getenv("MUXUS_DEV") == "1"
	overrides := server.Overrides{
		Port:         &port,
		OpenBrowser:  &openBrowser,
		PrettyLogs:   &prettyLogs,
		DatabasePath: paths.DesktopDatabasePath(),
	}
	if historyPath := flags["history-path"]; historyPath != "" {
		overrides.HistoryPath = historyPath
	} else {
		overrides.HistoryPath = os.Getenv("MUXUS_HISTORY_PATH")
	}
	if staticRoot := flags["static-root"]; staticRoot != "" {
		overrides.StaticRoot = staticRoot
	} else {
		overrides.StaticRoot = os.Getenv("MUXUS_STATIC_ROOT")
	}
	cfg := server.ResolveConfig(overrides)
	cfg.StaticFS = frontend.Assets()
	ctx, err := openContext(cfg)
	if err != nil {
		return err
	}
	return shell.Run(shell.Options{
		Config:         cfg,
		RegisterRoutes: registerAll(ctx),
		CloseBackend:   func() error { return closeContext(ctx) },
	})
}
