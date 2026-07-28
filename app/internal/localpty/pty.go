// Package localpty spawns local shell sessions on a pseudo-terminal,
// porting server/src/local/pty-manager.ts. ConPTY covers Windows via
// github.com/aymanbagabas/go-pty.
package localpty

import (
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	pty "github.com/aymanbagabas/go-pty"

	"github.com/FloSch62/muxus/app/internal/api"
)

const DefaultTerm = "xterm-256color"

// DefaultShell is the login shell a local terminal spawns when the profile
// has no override.
func DefaultShell() string {
	if isWindows() {
		if comspec := os.Getenv("COMSPEC"); comspec != "" {
			return comspec
		}
		return "powershell.exe"
	}
	if fromEnv := os.Getenv("SHELL"); fromEnv != "" {
		if _, err := os.Stat(fromEnv); err == nil {
			return fromEnv
		}
	}
	if _, err := os.Stat("/bin/zsh"); err == nil {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

// hostTerminalEnv matches vars describing whatever terminal launched the
// Muxus server itself — wrong and misleading inside PTYs that Muxus owns.
var hostTerminalEnv = regexp.MustCompile(
	`^(TERMINFO|TERM_PROGRAM|TERM_PROGRAM_VERSION|VTE_VERSION|WT_SESSION|WT_PROFILE_ID|KONSOLE_VERSION|KONSOLE_DBUS_\w+|ITERM_SESSION_ID|GNOME_TERMINAL_\w+|KITTY_\w+|WEZTERM_\w+|ALACRITTY_\w+)$`,
)

// Pty is a running local shell attached to a pseudo-terminal. It satisfies
// the terminal-socket transport contract plus exit handling.
type Pty struct {
	ptmx  pty.Pty
	cmd   *pty.Cmd
	Shell string

	waitOnce sync.Once
	exitCode int
	done     chan struct{}
}

// Spawn mirrors spawnLocalPty: filtered host env, integration shims, TERM
// vars, cwd fallback to the home directory.
func Spawn(profile *api.LocalProfile, cols, rows int) (*Pty, error) {
	shell := strings.TrimSpace(profile.Shell)
	if shell == "" {
		shell = DefaultShell()
	}

	baseEnv := map[string]string{}
	for _, kv := range os.Environ() {
		if key, value, ok := strings.Cut(kv, "="); ok {
			baseEnv[key] = value
		}
	}
	integration := Integration(shell, baseEnv, IntegrationRoot())

	env := map[string]string{}
	for key, value := range baseEnv {
		if !hostTerminalEnv.MatchString(key) {
			env[key] = value
		}
	}
	for key, value := range integration.Env {
		env[key] = value
	}
	env["TERM"] = DefaultTerm
	// Muxus renders 24-bit color; advertise it independently of terminfo.
	env["COLORTERM"] = "truecolor"
	env["TERM_PROGRAM"] = "muxus"

	cwd := strings.TrimSpace(profile.Cwd)
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}

	ptmx, err := pty.New()
	if err != nil {
		return nil, err
	}
	if err := ptmx.Resize(cols, rows); err != nil {
		_ = ptmx.Close()
		return nil, err
	}
	cmd := ptmx.Command(shell, integration.Args...)
	cmd.Dir = cwd
	cmd.Env = flattenEnv(env)
	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		return nil, err
	}

	p := &Pty{ptmx: ptmx, cmd: cmd, Shell: shell, done: make(chan struct{})}
	go p.reap()
	return p, nil
}

func flattenEnv(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}

func (p *Pty) reap() {
	p.waitOnce.Do(func() {
		err := p.cmd.Wait()
		if p.cmd.ProcessState != nil {
			p.exitCode = p.cmd.ProcessState.ExitCode()
		} else if err != nil {
			p.exitCode = 1
		}
		// go-pty holds the slave end open in this process, so the master
		// read never errors on child exit by itself. Give the pump a beat
		// to drain buffered output, then close the pty to unblock it; Read
		// converts the resulting error into EOF via the done channel.
		time.Sleep(100 * time.Millisecond)
		close(p.done)
		_ = p.ptmx.Close()
	})
}

// Read streams shell output. A PTY read fails with EIO once the child
// exits; report that as EOF so the socket layer treats it as completion.
// The child may die a moment after the read fails, so give the reaper a
// beat before deciding the error was genuine.
func (p *Pty) Read(buf []byte) (int, error) {
	n, err := p.ptmx.Read(buf)
	if err != nil && err != io.EOF {
		select {
		case <-p.done:
			return n, io.EOF
		case <-time.After(200 * time.Millisecond):
			return n, err
		}
	}
	return n, err
}

func (p *Pty) Write(data []byte) (int, error) {
	return p.ptmx.Write(data)
}

func (p *Pty) Resize(cols, rows int) error {
	return p.ptmx.Resize(cols, rows)
}

func (p *Pty) Close() error {
	return p.ptmx.Close()
}

// Wait blocks until the shell exits and returns its exit code.
func (p *Pty) Wait() int {
	<-p.done
	return p.exitCode
}

// Kill terminates the shell and releases the PTY.
func (p *Pty) Kill() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.ptmx.Close()
}

func isWindows() bool {
	return runtime.GOOS == "windows"
}
