package shell

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	stateFlushDelay = 150 * time.Millisecond
	stateRetryDelay = 5 * time.Second
)

type windowState struct {
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	X         *int `json:"x,omitempty"`
	Y         *int `json:"y,omitempty"`
	Maximized bool `json:"maximized,omitempty"`
}

func readWindowState(path string) windowState {
	fallback := windowState{Width: 1440, Height: 900}
	content, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var state windowState
	if json.Unmarshal(content, &state) != nil || state.Width <= 0 || state.Height <= 0 {
		return fallback
	}
	return state
}

func writeJSONAtomic(path string, value any) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	content = append(content, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, content, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type clientState struct {
	path    string
	onError func()

	mu      sync.Mutex
	values  map[string]string
	pending bool
	timer   *time.Timer
	closed  bool
}

func openClientState(path string, onError func()) *clientState {
	values := map[string]string{}
	if content, err := os.ReadFile(path); err == nil {
		var parsed map[string]any
		if json.Unmarshal(content, &parsed) == nil {
			for key, raw := range parsed {
				if value, ok := raw.(string); ok {
					values[key] = value
				}
			}
		}
	}
	return &clientState{path: path, values: values, onError: onError}
}

func (s *clientState) Snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneState(s.values)
}

func (s *clientState) Set(name, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.values[name] = value
	s.scheduleLocked(stateFlushDelay)
}

func (s *clientState) Remove(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	delete(s.values, name)
	s.scheduleLocked(stateFlushDelay)
}

func (s *clientState) scheduleLocked(delay time.Duration) {
	s.pending = true
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(delay, s.flush)
}

func (s *clientState) flush() {
	s.mu.Lock()
	if s.closed || !s.pending {
		s.timer = nil
		s.mu.Unlock()
		return
	}
	values := cloneState(s.values)
	s.pending = false
	s.timer = nil
	s.mu.Unlock()

	if err := writeJSONAtomic(s.path, values); err != nil {
		if s.onError != nil {
			s.onError()
		}
		s.mu.Lock()
		if !s.closed {
			s.pending = true
			s.scheduleLocked(stateRetryDelay)
		}
		s.mu.Unlock()
	}
}

func (s *clientState) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	pending := s.pending
	values := cloneState(s.values)
	s.pending = false
	s.mu.Unlock()
	if !pending {
		return nil
	}
	return writeJSONAtomic(s.path, values)
}

func cloneState(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func decodeJSONBody[T any](content []byte, result *T) error {
	if len(content) == 0 {
		return errors.New("empty request")
	}
	return json.Unmarshal(content, result)
}
