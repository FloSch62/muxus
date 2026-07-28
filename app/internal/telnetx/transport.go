package telnetx

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/FloSch62/muxus/app/internal/api"
)

const (
	connectTimeout  = 20 * time.Second
	keepalivePeriod = 30 * time.Second
)

// Transport is a Telnet terminal transport over TCP. Read yields decoded
// application bytes (negotiation consumed, IAC unescaped) and returns io.EOF
// when the remote closes cleanly; Write applies NVT/IAC encoding.
type Transport struct {
	conn net.Conn
	pr   *io.PipeReader
	pw   *io.PipeWriter

	// mu guards codec state and ended; wmu serializes socket writes so
	// negotiation replies from the read loop cannot interleave mid-frame
	// with terminal input. Lock order is always mu before wmu.
	mu    sync.Mutex
	wmu   sync.Mutex
	codec *Codec
	ended bool

	// pending collects application bytes during Feed/Flush; only the read
	// loop drains it, outside mu, so pipe backpressure never blocks
	// concurrent Write or Resize calls.
	pending []byte
}

// Connect dials the Telnet server and starts decoding. Nothing is negotiated
// proactively: options (including NAWS) are answered as the server requests
// them, matching TelnetTransport.connect.
func Connect(profile *api.TelnetProfile, cols, rows int) (*Transport, error) {
	addr := net.JoinHostPort(profile.Host, strconv.Itoa(profile.Port))
	conn, err := net.DialTimeout("tcp", addr, connectTimeout)
	if err != nil {
		return nil, friendlyError(err, profile)
	}
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(keepalivePeriod)
	}
	t := newTransport(conn, cols, rows)
	go t.readLoop()
	return t, nil
}

func newTransport(conn net.Conn, cols, rows int) *Transport {
	pr, pw := io.Pipe()
	t := &Transport{conn: conn, pr: pr, pw: pw}
	t.codec = NewCodec(cols, rows,
		func(data []byte) {
			t.wmu.Lock()
			_, _ = conn.Write(data)
			t.wmu.Unlock()
		},
		func(data []byte) {
			t.pending = append(t.pending, data...)
		},
	)
	return t
}

// readLoop feeds socket bytes through the codec into the pipe. The blocking
// pipe write is the flow control: a stalled consumer stalls the TCP window
// instead of buffering without bound.
func (t *Transport) readLoop() {
	buf := make([]byte, 32*1024)
	for {
		n, err := t.conn.Read(buf)
		if n > 0 {
			t.mu.Lock()
			t.codec.Feed(buf[:n])
			out := t.pending
			t.pending = nil
			t.mu.Unlock()
			if len(out) > 0 {
				if _, werr := t.pw.Write(out); werr != nil {
					return
				}
			}
		}
		if err != nil {
			t.mu.Lock()
			t.codec.Flush()
			out := t.pending
			t.pending = nil
			ended := t.ended
			t.mu.Unlock()
			if len(out) > 0 {
				_, _ = t.pw.Write(out)
			}
			if errors.Is(err, io.EOF) || ended {
				_ = t.pw.Close()
			} else {
				_ = t.pw.CloseWithError(err)
			}
			return
		}
	}
}

func (t *Transport) Read(p []byte) (int, error) {
	return t.pr.Read(p)
}

// Write encodes and sends terminal input. Errors after Close are swallowed
// like the socket.write fire-and-forget in the TS transport.
func (t *Transport) Write(p []byte) (int, error) {
	t.mu.Lock()
	if t.ended {
		t.mu.Unlock()
		return len(p), nil
	}
	encoded := t.codec.Encode(p)
	t.mu.Unlock()
	t.wmu.Lock()
	_, err := t.conn.Write(encoded)
	t.wmu.Unlock()
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (t *Transport) Resize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.codec.Resize(cols, rows)
	return nil
}

func (t *Transport) Close() error {
	t.mu.Lock()
	if t.ended {
		t.mu.Unlock()
		return nil
	}
	t.ended = true
	t.mu.Unlock()
	err := t.conn.Close()
	// Unblock a read loop parked on pipe backpressure.
	_ = t.pr.CloseWithError(net.ErrClosed)
	return err
}

// friendlyError rewrites the common dial failures into the user-facing
// messages the TS transport produces.
func friendlyError(err error, profile *api.TelnetProfile) error {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return fmt.Errorf("Telnet host not found: %s", profile.Host)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Errorf("Telnet connection refused by %s:%d", profile.Host, profile.Port)
	}
	var netErr net.Error
	if errors.Is(err, syscall.ETIMEDOUT) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return fmt.Errorf("Telnet connection to %s:%d timed out", profile.Host, profile.Port)
	}
	return err
}
