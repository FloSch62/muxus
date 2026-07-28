package server

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"strconv"

	"github.com/FloSch62/muxus/app/internal/paths"
)

// Config mirrors the Node ServerConfig (server/src/config.ts).
type Config struct {
	Host string
	Port int
	// Token is the bearer credential required on every request, fresh per run.
	Token string
	// DevToken replaces the random token in dev mode (Vite proxy can't learn a
	// random token at startup); the server still only listens on 127.0.0.1.
	DevToken    string
	OpenBrowser bool
	// StaticRoot overrides where the built client is served from. Empty means
	// the embedded assets (or the repo's client/dist in dev builds).
	StaticRoot string
	// StaticFS is the client embedded in release binaries. An explicit
	// StaticRoot wins so development and tests can serve live files.
	StaticFS     fs.FS
	DatabasePath string
	HistoryPath  string
	PrettyLogs   bool
}

func newToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// ResolveConfig fills defaults the way resolveConfig does. The zero Overrides
// value yields the standalone-server defaults.
type Overrides struct {
	Host         string
	Port         *int
	DevToken     string
	OpenBrowser  *bool
	StaticRoot   string
	DatabasePath string
	HistoryPath  string
	PrettyLogs   *bool
}

func ResolveConfig(o Overrides) Config {
	cfg := Config{
		Host:         "127.0.0.1",
		Port:         3002,
		OpenBrowser:  true,
		DatabasePath: paths.DefaultDatabasePath(),
		PrettyLogs:   os.Getenv("NODE_ENV") != "production",
	}
	if o.Host != "" {
		cfg.Host = o.Host
	}
	if o.Port != nil {
		cfg.Port = *o.Port
	}
	cfg.DevToken = o.DevToken
	if o.DevToken != "" {
		cfg.Token = o.DevToken
	} else {
		cfg.Token = newToken()
	}
	if o.OpenBrowser != nil {
		cfg.OpenBrowser = *o.OpenBrowser
	}
	cfg.StaticRoot = o.StaticRoot
	if o.DatabasePath != "" {
		cfg.DatabasePath = o.DatabasePath
	}
	cfg.HistoryPath = o.HistoryPath
	if o.PrettyLogs != nil {
		cfg.PrettyLogs = *o.PrettyLogs
	}
	return cfg
}

func ParsePort(raw string) (int, error) {
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid port %q — expected an integer between 1 and 65535", raw)
	}
	return port, nil
}
