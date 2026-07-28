// Package history is a 1:1 port of server/src/session-logging/history-store.ts
// and history-worker.js: session records, zstd-compressed raw output segments,
// SQLite FTS5 search, retention/pruning, and storage-location settings. The
// Node worker thread becomes a dedicated goroutine consuming a strictly
// ordered queue; the 8 MB pending-write budget is the backpressure bound.
package history

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	gonanoid "github.com/matoous/go-nanoid/v2"

	"github.com/FloSch62/muxus/app/internal/api"
)

// HistoryEvent mirrors HistoryEvent.
type HistoryEvent struct {
	Sequence   int64
	RecordedAt string
	ElapsedMs  int64
	Direction  string // "input" | "output" | "system"
	Raw        []byte
	Text       string
}

// SessionLogCreateInput mirrors SessionLogCreateInput from
// server/src/persistence/database.ts.
type SessionLogCreateInput struct {
	ProfileKey   string
	Title        string
	Kind         string
	Host         string
	StartedAt    string
	CaptureInput bool
}

// PartPolicy is Pick<SessionLoggingPolicy, 'maxPartBytes' | 'maxParts'>.
type PartPolicy struct {
	MaxPartBytes int
	MaxParts     int
}

// Query mirrors SessionHistoryQuery.
type Query struct {
	Query         string
	ProfileKey    string
	Host          string
	Kind          string
	StartedAfter  string
	StartedBefore string
	Limit         int
	Cursor        string
}

// Options mirrors the SessionHistoryStore.open input. An empty Root selects a
// temporary directory that Close removes.
type Options struct {
	Root               string
	Settings           api.SessionHistorySettings
	LegacyDatabasePath string
}

const maxPendingWriteBytes = 8 * 1024 * 1024

var errClosed = errors.New("session history store is closed")

type reqResult struct {
	value any
	err   error
}

type workerRequest struct {
	run      func(w *worker) (any, error)
	complete func(value any, err error)
	isClose  bool
}

// Store is the async facade for the dedicated history worker goroutine. The
// terminal transport only performs bounded memory copies; filesystem,
// compression, SQLite, quota, and search work all stays on the worker.
type Store struct {
	root          string
	temporaryRoot bool

	mu                sync.Mutex
	queue             []*workerRequest
	pendingWriteBytes int
	closed            bool
	failureListeners  map[string]map[int]func(string)
	nextListenerID    int
	settings          api.SessionHistorySettings

	signal     chan struct{}
	workerDone chan struct{}
}

// Open creates the store and waits for the worker to finish initialization
// (schema, trash cleanup, legacy import, crash recovery, first retention
// pass), mirroring SessionHistoryStore.open awaiting the 'ready' request.
func Open(opts Options) (*Store, error) {
	temporary := opts.Root == ""
	root := opts.Root
	if temporary {
		dir, err := os.MkdirTemp("", "muxus-session-history-")
		if err != nil {
			return nil, err
		}
		root = dir
	}
	resolved, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if filepath.Dir(resolved) == resolved {
		return nil, errors.New("the filesystem root cannot be used as the session history location")
	}
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return nil, err
	}
	s := &Store{
		root:             resolved,
		temporaryRoot:    temporary,
		failureListeners: map[string]map[int]func(string){},
		settings:         opts.Settings,
		signal:           make(chan struct{}, 1),
		workerDone:       make(chan struct{}),
	}
	w := newWorker(resolved, opts.Settings, opts.LegacyDatabasePath)
	go s.runWorker(w)
	if _, err := s.requestSync(func(*worker) (any, error) { return true, nil }); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

// Root is the resolved history root directory.
func (s *Store) Root() string { return s.root }

// BeginSession registers a new active session without awaiting disk.
func (s *Store) BeginSession(input SessionLogCreateInput, policy PartPolicy) string {
	id, err := gonanoid.New()
	if err != nil {
		id = fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	s.requestAsync(id, func(w *worker) (any, error) {
		return true, w.beginSession(id, input, policy)
	}, nil)
	return id
}

// Append queues one recorder batch without awaiting disk. False is explicit
// backpressure: callers must suspend logging for that session.
func (s *Store) Append(sessionID string, events []HistoryEvent, policy PartPolicy) bool {
	bytes := 0
	for _, event := range events {
		bytes += len(event.Raw) + len(event.Text) + 64
	}
	s.mu.Lock()
	if s.closed || bytes > maxPendingWriteBytes || s.pendingWriteBytes+bytes > maxPendingWriteBytes {
		s.mu.Unlock()
		return false
	}
	s.pendingWriteBytes += bytes
	s.mu.Unlock()
	// The Node worker receives a structured clone; copy raw payloads so later
	// caller mutations cannot corrupt queued frames.
	cloned := make([]HistoryEvent, len(events))
	for i, event := range events {
		event.Raw = append([]byte(nil), event.Raw...)
		cloned[i] = event
	}
	s.requestAsync(sessionID, func(w *worker) (any, error) {
		return w.appendEvents(sessionID, cloned, policy)
	}, func() {
		s.mu.Lock()
		s.pendingWriteBytes -= bytes
		if s.pendingWriteBytes < 0 {
			s.pendingWriteBytes = 0
		}
		s.mu.Unlock()
	})
	return true
}

// SetSessionState patches the persisted paused/captureInput flags.
func (s *Store) SetSessionState(sessionID string, paused, captureInput *bool) {
	s.requestAsync(sessionID, func(w *worker) (any, error) {
		return w.setSessionState(sessionID, paused, captureInput)
	}, nil)
}

// FinishSession marks a session completed/disconnected/failed.
func (s *Store) FinishSession(sessionID, status, endedAt string) {
	s.requestAsync(sessionID, func(w *worker) (any, error) {
		return true, w.finishSession(sessionID, status, endedAt)
	}, nil)
}

// OnSessionFailure subscribes to async persistence failures for one session
// and returns the unsubscribe function.
func (s *Store) OnSessionFailure(sessionID string, listener func(message string)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	listeners := s.failureListeners[sessionID]
	if listeners == nil {
		listeners = map[int]func(string){}
		s.failureListeners[sessionID] = listeners
	}
	id := s.nextListenerID
	s.nextListenerID++
	listeners[id] = listener
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if set, ok := s.failureListeners[sessionID]; ok {
			delete(set, id)
			if len(set) == 0 {
				delete(s.failureListeners, sessionID)
			}
		}
	}
}

// SessionHistory lists/searches retained sessions.
func (s *Store) SessionHistory(input Query) (api.SessionHistoryResponse, error) {
	value, err := s.requestSync(func(w *worker) (any, error) { return w.search(input) })
	if err != nil {
		return api.SessionHistoryResponse{}, err
	}
	return value.(api.SessionHistoryResponse), nil
}

// SessionLog returns one session with normalized events, nil when unknown.
// A non-nil eventLimit returns only the newest eventLimit chunks.
func (s *Store) SessionLog(id string, eventLimit *int) (*api.SessionLogDetail, error) {
	value, err := s.requestSync(func(w *worker) (any, error) { return w.detail(id, eventLimit) })
	if err != nil {
		return nil, err
	}
	return value.(*api.SessionLogDetail), nil
}

// RawSessionLogEvents returns the exact raw byte events, nil when unknown.
func (s *Store) RawSessionLogEvents(id string) ([]HistoryEvent, error) {
	value, err := s.requestSync(func(w *worker) (any, error) { return w.rawEvents(id) })
	if err != nil {
		return nil, err
	}
	return value.([]HistoryEvent), nil
}

// DeleteSession removes one non-active session.
func (s *Store) DeleteSession(id string) (bool, error) {
	value, err := s.requestSync(func(w *worker) (any, error) { return w.deleteSession(id, false) })
	if err != nil {
		return false, err
	}
	return value.(bool), nil
}

// SetPinned toggles retention pinning.
func (s *Store) SetPinned(id string, pinned bool) (bool, error) {
	value, err := s.requestSync(func(w *worker) (any, error) { return w.setPinned(id, pinned) })
	if err != nil {
		return false, err
	}
	return value.(bool), nil
}

// UpdateSettings applies new global limits and re-runs retention.
func (s *Store) UpdateSettings(settings api.SessionHistorySettings) error {
	s.mu.Lock()
	s.settings = settings
	s.mu.Unlock()
	_, err := s.requestSync(func(w *worker) (any, error) {
		w.settings = settings
		return true, w.enforceRetention(true)
	})
	return err
}

// StorageStatus reports live usage/quota state. configuredLocation is the
// storage root that will be used on the next launch.
func (s *Store) StorageStatus(configuredLocation string) (api.SessionHistoryStorageStatus, error) {
	value, err := s.requestSync(func(w *worker) (any, error) {
		return w.storageStatus(configuredLocation)
	})
	if err != nil {
		return api.SessionHistoryStorageStatus{}, err
	}
	return value.(api.SessionHistoryStorageStatus), nil
}

// Close finalizes writers, marks active sessions disconnected, closes the
// database, and removes a temporary root.
func (s *Store) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	done := make(chan reqResult, 1)
	s.enqueue(&workerRequest{
		isClose:  true,
		complete: func(value any, err error) { done <- reqResult{value, err} },
	})
	// The worker may already have stopped after a fatal storage failure; the
	// close error is intentionally ignored, matching the Node try/catch.
	<-done
	<-s.workerDone
	if s.temporaryRoot {
		_ = os.RemoveAll(s.root)
	}
	return nil
}

func (s *Store) enqueue(req *workerRequest) {
	s.mu.Lock()
	s.queue = append(s.queue, req)
	s.mu.Unlock()
	select {
	case s.signal <- struct{}{}:
	default:
	}
}

func (s *Store) requestSync(run func(w *worker) (any, error)) (any, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errClosed
	}
	s.mu.Unlock()
	done := make(chan reqResult, 1)
	s.enqueue(&workerRequest{
		run:      run,
		complete: func(value any, err error) { done <- reqResult{value, err} },
	})
	result := <-done
	return result.value, result.err
}

// requestAsync is the fire-and-forget path: errors surface only through the
// per-session failure listeners, never to the caller.
func (s *Store) requestAsync(sessionID string, run func(w *worker) (any, error), after func()) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		if after != nil {
			after()
		}
		s.notifyFailure(sessionID, errClosed.Error())
		return
	}
	s.mu.Unlock()
	s.enqueue(&workerRequest{
		run: run,
		complete: func(_ any, err error) {
			if err != nil {
				s.notifyFailure(sessionID, err.Error())
			}
			if after != nil {
				after()
			}
		},
	})
}

func (s *Store) notifyFailure(sessionID, message string) {
	s.mu.Lock()
	listeners := make([]func(string), 0, len(s.failureListeners[sessionID]))
	for _, listener := range s.failureListeners[sessionID] {
		listeners = append(listeners, listener)
	}
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(message)
	}
}

// runWorker preserves the Node worker's strict message ordering: one
// goroutine drains the queue FIFO, so begin/append/finish/search for any
// session observe each other in submission order.
func (s *Store) runWorker(w *worker) {
	defer close(s.workerDone)
	initErr := w.init()
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		var req *workerRequest
		if len(s.queue) > 0 {
			req = s.queue[0]
			s.queue = s.queue[1:]
		}
		s.mu.Unlock()
		if req == nil {
			select {
			case <-s.signal:
			case <-ticker.C:
				if initErr == nil {
					w.maintenance()
				}
			}
			continue
		}
		if req.isClose {
			var err error
			if initErr == nil {
				err = w.closeWorker()
			}
			req.complete(true, err)
			s.mu.Lock()
			rest := s.queue
			s.queue = nil
			s.mu.Unlock()
			for _, leftover := range rest {
				leftover.complete(nil, errClosed)
			}
			return
		}
		if initErr != nil {
			req.complete(nil, initErr)
			continue
		}
		runRequest(w, req)
	}
}

func runRequest(w *worker, req *workerRequest) {
	defer func() {
		if p := recover(); p != nil {
			req.complete(nil, fmt.Errorf("session history worker failed: %v", p))
		}
	}()
	value, err := req.run(w)
	req.complete(value, err)
}

// DefaultRoot mirrors defaultHistoryRoot: the history directory next to the
// application database, or empty for an in-memory database.
func DefaultRoot(databasePath string) string {
	if databasePath == ":memory:" {
		return ""
	}
	return filepath.Join(filepath.Dir(databasePath), "history")
}
