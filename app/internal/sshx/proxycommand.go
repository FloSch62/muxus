package sshx

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProxyCommand support: run the configured command through the user's
// platform shell and expose its stdin/stdout as the byte stream the SSH
// handshake runs over — OpenSSH shell-command semantics, including pipes and
// quoted arguments. Port of openProxyCommand/expandProxyCommand.

const proxyStderrLimit = 8 * 1024

var proxyTokenRe = regexp.MustCompile(`%%|%[hnpr]`)

// ProxyTokens carries the values for the tokens OpenSSH's ProxyCommand
// directive accepts.
type ProxyTokens struct {
	Hostname     string
	OriginalHost string
	Port         int
	User         string
}

func ExpandProxyCommand(command string, tokens ProxyTokens) string {
	return proxyTokenRe.ReplaceAllStringFunc(command, func(token string) string {
		switch token {
		case "%%":
			return "%"
		case "%h":
			return tokens.Hostname
		case "%n":
			return tokens.OriginalHost
		case "%p":
			return strconv.Itoa(tokens.Port)
		default:
			return tokens.User
		}
	})
}

// proxyConn adapts the child process's stdio to net.Conn for the SSH
// handshake.
type proxyConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	mu       sync.Mutex
	stderr   strings.Builder
	closed   bool
	exitErr  error
	exited   bool
	signaled string
	exitCode int
}

// OpenProxyCommand starts the command under the platform shell. The returned
// net.Conn reports a descriptive error when the command fails to start or
// exits non-zero, including captured stderr.
func OpenProxyCommand(command string) (net.Conn, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ProxyCommand could not start: %w", err)
	}

	conn := &proxyConn{cmd: cmd, stdin: stdin, stdout: stdout}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := stderrPipe.Read(buf)
			if n > 0 {
				conn.mu.Lock()
				conn.stderr.Write(buf[:n])
				if conn.stderr.Len() > proxyStderrLimit {
					trimmed := conn.stderr.String()
					trimmed = trimmed[len(trimmed)-proxyStderrLimit:]
					conn.stderr.Reset()
					conn.stderr.WriteString(trimmed)
				}
				conn.mu.Unlock()
			}
			if readErr != nil {
				return
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		conn.mu.Lock()
		defer conn.mu.Unlock()
		conn.exited = true
		if exitErr := new(exec.ExitError); errors.As(err, &exitErr) {
			conn.exitCode = exitErr.ExitCode()
			if status := exitErr.ProcessState.String(); strings.Contains(status, "signal:") {
				conn.signaled = strings.TrimPrefix(status, "signal: ")
			}
		}
	}()
	return conn, nil
}

// exitError builds the same failure message the Node implementation reports.
func (c *proxyConn) exitError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.exited || c.exitCode == 0 && c.signaled == "" {
		return nil
	}
	reason := fmt.Sprintf("exit code %d", c.exitCode)
	if c.signaled != "" {
		reason = "signal " + strings.ToUpper(strings.Fields(c.signaled)[0])
	}
	detail := strings.TrimSpace(c.stderr.String())
	if detail != "" {
		return fmt.Errorf("ProxyCommand failed with %s: %s", reason, detail)
	}
	return fmt.Errorf("ProxyCommand failed with %s", reason)
}

func (c *proxyConn) Read(p []byte) (int, error) {
	n, err := c.stdout.Read(p)
	if err != nil {
		if exitErr := c.exitError(); exitErr != nil {
			return n, exitErr
		}
	}
	return n, err
}

func (c *proxyConn) Write(p []byte) (int, error) {
	n, err := c.stdin.Write(p)
	if err != nil {
		if exitErr := c.exitError(); exitErr != nil {
			return n, exitErr
		}
	}
	return n, err
}

func (c *proxyConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	exited := c.exited
	c.mu.Unlock()
	_ = c.stdin.Close()
	_ = c.stdout.Close()
	if !exited && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	return nil
}

type proxyAddr struct{}

func (proxyAddr) Network() string { return "proxy" }
func (proxyAddr) String() string  { return "proxy-command" }

func (c *proxyConn) LocalAddr() net.Addr                { return proxyAddr{} }
func (c *proxyConn) RemoteAddr() net.Addr               { return proxyAddr{} }
func (c *proxyConn) SetDeadline(t time.Time) error      { return nil }
func (c *proxyConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *proxyConn) SetWriteDeadline(t time.Time) error { return nil }
