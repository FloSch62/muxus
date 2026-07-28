package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
)

// Running mirrors RunningServer: PublicURL never contains the bearer token;
// BrowserURL carries it in the fragment, which is never sent in a request.
type Running struct {
	Config     Config
	Port       int
	Token      string
	URL        string
	BrowserURL string
	httpServer *http.Server
	shutdown   []func() error
}

// Start listens (port 0 picks any free port), reads the real port back, and
// serves in a background goroutine — the Go equivalent of startServer.
func Start(cfg Config, registerRoutes func(r chi.Router), onClose ...func() error) (*Running, error) {
	logLevel := slog.LevelInfo
	if v := os.Getenv("LOG_LEVEL"); v == "debug" {
		logLevel = slog.LevelDebug
	}
	var handler slog.Handler
	if cfg.PrettyLogs {
		handler = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel})
	} else {
		handler = slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel})
	}
	logger := slog.New(handler)

	ctx := &Context{Config: cfg, Log: logger}
	router := NewRouter(ctx, registerRoutes)

	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Host, cfg.Port))
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	urls := ServerURLs(cfg.Host, port, cfg.Token)

	httpServer := &http.Server{Handler: router}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", "error", err)
		}
	}()
	logger.Info("muxus server listening", "url", urls.PublicURL)

	return &Running{
		Config:     cfg,
		Port:       port,
		Token:      cfg.Token,
		URL:        urls.PublicURL,
		BrowserURL: urls.BrowserURL,
		httpServer: httpServer,
		shutdown:   onClose,
	}, nil
}

// Close drains HTTP and then runs the registered subsystem shutdowns in
// order (forwards → connections → history → database, once those exist).
func (s *Running) Close() error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := s.httpServer.Shutdown(shutdownCtx)
	for _, fn := range s.shutdown {
		if closeErr := fn(); closeErr != nil && err == nil {
			err = closeErr
		}
	}
	return err
}
