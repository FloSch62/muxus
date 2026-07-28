// Package ws implements the WebSocket endpoints: /ws/terminal and
// /ws/sftp/{connId}/lease.
package ws

import (
	"errors"
	"sync"

	"github.com/FloSch62/muxus/app/internal/api"
)

// ErrConnectionClosed mirrors the Node control channel's rejection reason.
var ErrConnectionClosed = errors.New("connection closed")

// ControlChannel splits JSON control frames from the binary stream, with
// waiters for the auth round-trips. Mirrors terminal-socket.ts ControlChannel:
// Intercept short-circuits (set-logging during a live session); a queued
// waiter takes priority; OnMessage handles steady-state frames (resize).
type ControlChannel struct {
	mu        sync.Mutex
	waiters   []chan waiterResult
	closed    bool
	Intercept func(msg api.TerminalClientMessage) bool
	OnMessage func(msg api.TerminalClientMessage)
}

type waiterResult struct {
	msg api.TerminalClientMessage
	err error
}

func (c *ControlChannel) Push(msg api.TerminalClientMessage) {
	c.mu.Lock()
	intercept := c.Intercept
	c.mu.Unlock()
	if intercept != nil && intercept(msg) {
		return
	}

	c.mu.Lock()
	if len(c.waiters) > 0 {
		waiter := c.waiters[0]
		c.waiters = c.waiters[1:]
		c.mu.Unlock()
		waiter <- waiterResult{msg: msg}
		return
	}
	onMessage := c.OnMessage
	c.mu.Unlock()
	if onMessage != nil {
		onMessage(msg)
	}
}

// Next awaits the next control frame (connect / auth-response /
// host-key-response). It never returns a message after Close.
func (c *ControlChannel) Next() (api.TerminalClientMessage, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return api.TerminalClientMessage{}, ErrConnectionClosed
	}
	waiter := make(chan waiterResult, 1)
	c.waiters = append(c.waiters, waiter)
	c.mu.Unlock()

	result := <-waiter
	return result.msg, result.err
}

// SetHandlers swaps the intercept/steady-state handlers atomically with
// respect to Push.
func (c *ControlChannel) SetHandlers(intercept func(api.TerminalClientMessage) bool, onMessage func(api.TerminalClientMessage)) {
	c.mu.Lock()
	c.Intercept = intercept
	c.OnMessage = onMessage
	c.mu.Unlock()
}

func (c *ControlChannel) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	waiters := c.waiters
	c.waiters = nil
	c.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- waiterResult{err: ErrConnectionClosed}
	}
}
