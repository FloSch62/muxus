package sshx

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// Cases ported from tests/unit/server/remote-shell-integration.test.ts,
// adapted to the Go decomposition (PrepareIntegratedShell returns the shell
// command; channel opening belongs to the connection manager).

type fakeProbeExec struct {
	mu       sync.Mutex
	commands []string
	output   string
	order    *[]string
	delay    time.Duration
}

type fakeProbeStream struct {
	reader io.Reader
	delay  time.Duration
	order  *[]string
	mu     *sync.Mutex
	read   bool
}

func (s *fakeProbeStream) Read(p []byte) (int, error) {
	if !s.read {
		s.read = true
		time.Sleep(s.delay)
		if s.order != nil {
			s.mu.Lock()
			*s.order = append(*s.order, "probe-finish")
			s.mu.Unlock()
		}
	}
	return s.reader.Read(p)
}

func (s *fakeProbeStream) Close() error { return nil }

func (f *fakeProbeExec) Exec(command string) (io.ReadCloser, error) {
	f.mu.Lock()
	f.commands = append(f.commands, command)
	if f.order != nil {
		*f.order = append(*f.order, "probe-start")
	}
	f.mu.Unlock()
	return &fakeProbeStream{reader: strings.NewReader(f.output), delay: f.delay, order: f.order, mu: &f.mu}, nil
}

type fakeFileInfo struct {
	dir bool
}

func (f fakeFileInfo) Name() string { return "" }
func (f fakeFileInfo) Size() int64  { return 0 }
func (f fakeFileInfo) Mode() fs.FileMode {
	if f.dir {
		return fs.ModeDir | 0o700
	}
	return 0o600
}
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.dir }
func (f fakeFileInfo) Sys() any           { return nil }

type fakeSftp struct {
	mu             sync.Mutex
	statCalls      int
	mkdirs         []string
	writes         []string
	completeIsFile bool
}

func (f *fakeSftp) Stat(remotePath string) (os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statCalls++
	if strings.HasSuffix(remotePath, "/.complete") {
		if f.completeIsFile {
			return fakeFileInfo{dir: false}, nil
		}
		return nil, errors.New("not found")
	}
	return fakeFileInfo{dir: true}, nil
}

func (f *fakeSftp) Mkdir(remotePath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mkdirs = append(f.mkdirs, remotePath)
	return nil
}

func (f *fakeSftp) WriteFile(remotePath string, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, remotePath)
	return nil
}

func TestProbesInstallsAndBuildsIntegratedZshCommand(t *testing.T) {
	var order []string
	exec := &fakeProbeExec{
		output: "__MUXUS_SHELL__=/usr/bin/zsh\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n",
		order:  &order,
		delay:  30 * time.Millisecond,
	}
	sftpClient := &fakeSftp{}

	command, err := PrepareIntegratedShell(exec, func() (IntegrationSftp, error) {
		exec.mu.Lock()
		order = append(order, "sftp-start")
		exec.mu.Unlock()
		return sftpClient, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(order) < 3 || order[0] != "probe-start" || order[1] != "sftp-start" || order[2] != "probe-finish" {
		t.Fatalf("setup order = %v, want probe and sftp overlapped", order)
	}
	if !strings.Contains(exec.commands[0], `"${SHELL-}" "${ZDOTDIR-}" "${HOME-}"`) {
		t.Fatalf("probe command mangled: %q", exec.commands[0])
	}
	if strings.Contains(exec.commands[0], `\${SHELL-}`) {
		t.Fatalf("probe command double-escaped: %q", exec.commands[0])
	}
	if !regexp.MustCompile(`export ZDOTDIR='/home/u/\.cache/muxus/shell-integration/[a-f0-9]{12}/zsh'`).MatchString(command) {
		t.Fatalf("shell command = %q", command)
	}
	if len(sftpClient.writes) != 4 {
		t.Fatalf("writes = %v, want 4", sftpClient.writes)
	}
	wantSuffixes := []string{"/zsh/.zshenv", "/zsh/.zprofile", "/zsh/.zshrc", "/.complete"}
	for i, suffix := range wantSuffixes {
		if !strings.HasSuffix(sftpClient.writes[i], suffix) {
			t.Fatalf("write %d = %q, want suffix %q", i, sftpClient.writes[i], suffix)
		}
	}
}

func TestReusesCompletedInstallWithoutRemoteWrites(t *testing.T) {
	exec := &fakeProbeExec{
		output: "__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n",
	}
	sftpClient := &fakeSftp{completeIsFile: true}

	command, err := PrepareIntegratedShell(exec, func() (IntegrationSftp, error) { return sftpClient, nil })
	if err != nil {
		t.Fatal(err)
	}
	if sftpClient.statCalls != 1 {
		t.Fatalf("stat calls = %d, want 1", sftpClient.statCalls)
	}
	if len(sftpClient.mkdirs) != 0 || len(sftpClient.writes) != 0 {
		t.Fatalf("cached install must not write: mkdirs=%v writes=%v", sftpClient.mkdirs, sftpClient.writes)
	}
	if !regexp.MustCompile(`--rcfile '/home/u/\.cache/muxus/shell-integration/[a-f0-9]{12}/bash-init\.bash'`).MatchString(command) {
		t.Fatalf("shell command = %q", command)
	}
}

func TestParseShellProbeDetectsSupportedShells(t *testing.T) {
	got := ParseShellProbe("banner\n__MUXUS_SHELL__=/usr/bin/zsh\n__MUXUS_ZDOTDIR__=/home/u/.config/zsh\n__MUXUS_HOME__=/home/u\n")
	want := &SupportedShell{Path: "/usr/bin/zsh", Kind: "zsh", Home: "/home/u", Zdotdir: "/home/u/.config/zsh"}
	if got == nil || *got != *want {
		t.Fatalf("probe = %+v, want %+v", got, want)
	}
	got = ParseShellProbe("__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n")
	want = &SupportedShell{Path: "/bin/bash", Kind: "bash", Home: "/home/u"}
	if got == nil || *got != *want {
		t.Fatalf("probe = %+v, want %+v", got, want)
	}
}

func TestParseShellProbeRejectsUnsupportedAndMissing(t *testing.T) {
	if got := ParseShellProbe("__MUXUS_SHELL__=/usr/bin/fish\n__MUXUS_ZDOTDIR__=\n__MUXUS_HOME__=/home/u\n"); got != nil {
		t.Fatalf("fish must be rejected, got %+v", got)
	}
	if got := ParseShellProbe("__MUXUS_SHELL__=/bin/bash\n__MUXUS_ZDOTDIR__=\n"); got != nil {
		t.Fatalf("missing home must be rejected, got %+v", got)
	}
	if got := ParseShellProbe(""); got != nil {
		t.Fatalf("empty output must be rejected, got %+v", got)
	}
}

func TestRemoteShellCommandZshPreservesCustomZdotdir(t *testing.T) {
	got := RemoteShellCommand(&SupportedShell{
		Path: "/usr/bin/zsh", Kind: "zsh", Home: "/home/u", Zdotdir: "/home/o'hara/.config/zsh",
	}, "/home/u/.cache/muxus")
	want := `export MUXUS_USER_ZDOTDIR='/home/o'\''hara/.config/zsh'; export ZDOTDIR='/home/u/.cache/muxus/zsh'; exec '/usr/bin/zsh' -l`
	if got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
}

func TestRemoteShellCommandBashUsesInitFile(t *testing.T) {
	got := RemoteShellCommand(&SupportedShell{Path: "/bin/bash", Kind: "bash", Home: "/home/u"}, "/home/u/.cache/muxus")
	want := `exec '/bin/bash' --noprofile --rcfile '/home/u/.cache/muxus/bash-init.bash' -i`
	if got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
}
