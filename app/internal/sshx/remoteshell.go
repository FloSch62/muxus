package sshx

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	path "path"
	"regexp"
	"strings"
	"time"

	"github.com/FloSch62/muxus/app/internal/localpty"
)

// Remote shell integration: install the same OSC 133 rc shims used for local
// terminals onto the SSH host over SFTP, then exec the shell through them.
// Port of server/src/ssh/remote-shell-integration.ts.

const remoteShellProbe = `command printf '\n__MUXUS_SHELL__=%s\n__MUXUS_ZDOTDIR__=%s\n__MUXUS_HOME__=%s\n' "${SHELL-}" "${ZDOTDIR-}" "${HOME-}"`

const (
	remoteProbeTimeout   = 5 * time.Second
	remoteMaxProbeOutput = 8 * 1024
	remoteInstallMarker  = ".complete"
)

const remoteZprofile = `# Preserve login-zsh startup while ZDOTDIR points at the Muxus shim.
__muxus_shim="$ZDOTDIR"
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
if [[ -f "${ZDOTDIR:-$HOME}/.zprofile" ]]; then builtin source "${ZDOTDIR:-$HOME}/.zprofile"; fi
if [[ -n "$ZDOTDIR" ]]; then MUXUS_USER_ZDOTDIR="$ZDOTDIR"; else builtin unset MUXUS_USER_ZDOTDIR; fi
ZDOTDIR="$__muxus_shim"
builtin unset __muxus_shim
`

const remoteBashInit = `# Muxus SSH shell integration. Reproduce login startup first.
if [[ -f /etc/profile ]]; then . /etc/profile; fi
if [[ -f "$HOME/.bash_profile" ]]; then
  . "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  . "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  . "$HOME/.profile"
fi

if [[ $- == *i* && -z "$__muxus_integrated" ]]; then
  __muxus_integrated=1
  __muxus_prompt_mark() {
    local __muxus_status=$?
    printf '\e]133;D;%s\a' "$__muxus_status"
    printf '\e]133;A\a'
  }
  PS0="\[\e]133;C\a\]${PS0-}"
  PROMPT_COMMAND="__muxus_prompt_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`

// remoteIntegrationVersion content-addresses the install directory so future
// connections need only one SFTP stat instead of rewriting files over the
// WAN. Hash inputs and order must stay identical to the Node implementation
// so Go and Node installs share the remote cache directory.
func remoteIntegrationVersion() string {
	h := sha256.New()
	h.Write([]byte(localpty.Zshenv))
	h.Write([]byte(remoteZprofile))
	h.Write([]byte(localpty.Zshrc))
	h.Write([]byte(remoteBashInit))
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// SupportedShell describes a probed remote shell eligible for integration.
type SupportedShell struct {
	Path    string
	Kind    string // "bash" | "zsh"
	Home    string
	Zdotdir string
}

var (
	remoteProbeShellRe   = regexp.MustCompile(`(?m)^__MUXUS_SHELL__=([^\r\n]+)$`)
	remoteProbeHomeRe    = regexp.MustCompile(`(?m)^__MUXUS_HOME__=(/[^\r\n]*)$`)
	remoteProbeZdotdirRe = regexp.MustCompile(`(?m)^__MUXUS_ZDOTDIR__=([^\r\n]*)$`)
)

// ParseShellProbe extracts the supported shell from probe output, tolerating
// login banners around the markers.
func ParseShellProbe(output string) *SupportedShell {
	shellMatch := remoteProbeShellRe.FindStringSubmatch(output)
	if shellMatch == nil {
		return nil
	}
	shellPath := strings.TrimSpace(shellMatch[1])
	if shellPath == "" || strings.ContainsRune(shellPath, 0) {
		return nil
	}
	name := path.Base(shellPath)
	if name != "bash" && name != "zsh" {
		return nil
	}
	homeMatch := remoteProbeHomeRe.FindStringSubmatch(output)
	if homeMatch == nil {
		return nil
	}
	home := strings.TrimSpace(homeMatch[1])
	if home == "" || strings.ContainsRune(home, 0) {
		return nil
	}
	shell := &SupportedShell{Path: shellPath, Kind: name, Home: home}
	if zdotdirMatch := remoteProbeZdotdirRe.FindStringSubmatch(output); zdotdirMatch != nil {
		shell.Zdotdir = strings.TrimSpace(zdotdirMatch[1])
	}
	return shell
}

// RemoteShellCommand builds the exec command that starts the shell through
// the installed shims.
func RemoteShellCommand(shell *SupportedShell, root string) string {
	executable := quoteShellWord(shell.Path)
	if shell.Kind == "bash" {
		return fmt.Sprintf("exec %s --noprofile --rcfile %s -i",
			executable, quoteShellWord(path.Join(root, "bash-init.bash")))
	}
	userZdotdir := "unset MUXUS_USER_ZDOTDIR; "
	if shell.Zdotdir != "" {
		userZdotdir = fmt.Sprintf("export MUXUS_USER_ZDOTDIR=%s; ", quoteShellWord(shell.Zdotdir))
	}
	return fmt.Sprintf("%sexport ZDOTDIR=%s; exec %s -l",
		userZdotdir, quoteShellWord(path.Join(root, "zsh")), executable)
}

func quoteShellWord(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// ProbeExec runs a remote command without a PTY and returns its combined
// output stream. Production wraps an x/crypto ssh session; tests use fakes.
type ProbeExec interface {
	Exec(command string) (io.ReadCloser, error)
}

// IntegrationSftp is the minimal SFTP surface the installer needs.
type IntegrationSftp interface {
	Stat(remotePath string) (os.FileInfo, error)
	Mkdir(remotePath string) error
	WriteFile(remotePath string, content []byte) error
}

// probeRemoteShell runs the probe with the same 5s timeout and 8KB output
// cap as the Node implementation. Unsupported shells yield (nil, nil).
func probeRemoteShell(exec ProbeExec) (*SupportedShell, error) {
	stream, err := exec.Exec(remoteShellProbe)
	if err != nil {
		return nil, nil
	}
	type readResult struct {
		output string
	}
	done := make(chan readResult, 1)
	go func() {
		var out strings.Builder
		buf := make([]byte, 4096)
		for out.Len() < remoteMaxProbeOutput {
			n, readErr := stream.Read(buf)
			if n > 0 {
				remaining := remoteMaxProbeOutput - out.Len()
				if n > remaining {
					n = remaining
				}
				out.Write(buf[:n])
			}
			if readErr != nil {
				break
			}
		}
		done <- readResult{output: out.String()}
	}()
	select {
	case result := <-done:
		_ = stream.Close()
		return ParseShellProbe(result.output), nil
	case <-time.After(remoteProbeTimeout):
		_ = stream.Close()
		select {
		case result := <-done:
			return ParseShellProbe(result.output), nil
		case <-time.After(time.Second):
			return nil, nil
		}
	}
}

// installRemoteIntegration writes the shims into the content-addressed
// directory; a present completion marker skips every other round-trip.
func installRemoteIntegration(sftpClient IntegrationSftp, shell *SupportedShell) (string, error) {
	root := path.Join(shell.Home, ".cache", "muxus", "shell-integration", remoteIntegrationVersion())
	completePath := path.Join(root, remoteInstallMarker)
	if info, err := sftpClient.Stat(completePath); err == nil && info.Mode().IsRegular() {
		return root, nil
	}

	directories := []string{root}
	if shell.Kind == "zsh" {
		directories = append(directories, path.Join(root, "zsh"))
	}
	for _, directory := range directories {
		if err := remoteEnsureDirectory(sftpClient, directory); err != nil {
			return "", err
		}
	}

	type remoteFile struct {
		path    string
		content string
	}
	var files []remoteFile
	if shell.Kind == "zsh" {
		files = []remoteFile{
			{path.Join(root, "zsh", ".zshenv"), localpty.Zshenv},
			{path.Join(root, "zsh", ".zprofile"), remoteZprofile},
			{path.Join(root, "zsh", ".zshrc"), localpty.Zshrc},
		}
	} else {
		files = []remoteFile{{path.Join(root, "bash-init.bash"), remoteBashInit}}
	}
	for _, file := range files {
		if err := sftpClient.WriteFile(file.path, []byte(file.content)); err != nil {
			return "", err
		}
	}
	// Written last so interrupted installs are repaired on the next attempt.
	if err := sftpClient.WriteFile(completePath, []byte(remoteIntegrationVersion())); err != nil {
		return "", err
	}
	return root, nil
}

func remoteEnsureDirectory(sftpClient IntegrationSftp, directory string) error {
	normalized := path.Clean(directory)
	parts := strings.Split(normalized, "/")
	current := "/"
	for _, part := range parts {
		if part == "" {
			continue
		}
		current = path.Join(current, part)
		if info, err := sftpClient.Stat(current); err == nil {
			if info.IsDir() {
				continue
			}
			return fmt.Errorf("%s is not a directory", current)
		}
		if err := sftpClient.Mkdir(current); err != nil {
			// Another terminal may have created it between stat and mkdir.
			if info, statErr := sftpClient.Stat(current); statErr != nil || !info.IsDir() {
				return err
			}
		}
	}
	return nil
}

// PrepareIntegratedShell probes the remote shell and installs the shims,
// returning the command that opens the integrated shell — empty when the
// remote cannot support the bootstrap, so callers open a plain shell
// instead. Shell detection and SFTP channel setup are independent network
// round-trips, so they overlap on the same SSH transport.
func PrepareIntegratedShell(exec ProbeExec, getSftp func() (IntegrationSftp, error)) (string, error) {
	type sftpResult struct {
		client IntegrationSftp
		err    error
	}
	sftpCh := make(chan sftpResult, 1)
	go func() {
		client, err := getSftp()
		sftpCh <- sftpResult{client, err}
	}()

	shell, err := probeRemoteShell(exec)
	if err != nil || shell == nil {
		return "", nil
	}
	sftpRes := <-sftpCh
	if sftpRes.err != nil {
		return "", nil
	}
	root, err := installRemoteIntegration(sftpRes.client, shell)
	if err != nil {
		return "", nil
	}
	return RemoteShellCommand(shell, root), nil
}
