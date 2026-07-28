package localpty

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Cases ported from tests/unit/server/shell-integration.test.ts.

func writtenRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := WriteIntegrationFiles(root); err != nil {
		t.Fatal(err)
	}
	return root
}

func readShim(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestZshShimEmitsOSC133CommandReports(t *testing.T) {
	root := writtenRoot(t)
	zshrc := readShim(t, root, "zsh/.zshrc")
	for _, want := range []string{`\e]133;D;%s\a`, `\e]133;C\a`, "add-zsh-hook precmd", "add-zsh-hook preexec"} {
		if !strings.Contains(zshrc, want) {
			t.Fatalf(".zshrc missing %q", want)
		}
	}
}

func TestZshShimSourcesUserStartupFilesFirst(t *testing.T) {
	root := writtenRoot(t)
	if !strings.Contains(readShim(t, root, "zsh/.zshenv"), "${ZDOTDIR:-$HOME}/.zshenv") {
		t.Fatal(".zshenv must source the user .zshenv")
	}
	if !strings.Contains(readShim(t, root, "zsh/.zshrc"), "${ZDOTDIR:-$HOME}/.zshrc") {
		t.Fatal(".zshrc must source the user .zshrc")
	}
}

func TestBashShimReportsViaPS0AndPromptCommand(t *testing.T) {
	root := writtenRoot(t)
	bash := readShim(t, root, "bash-init.bash")
	for _, want := range []string{
		`"$HOME/.bashrc"`,
		`PS0="\[\e]133;C\a\]${PS0-}"`,
		`PROMPT_COMMAND="__muxus_prompt_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
	} {
		if !strings.Contains(bash, want) {
			t.Fatalf("bash-init.bash missing %q", want)
		}
	}
}

func TestZshRedirectedThroughShimZdotdir(t *testing.T) {
	root := writtenRoot(t)
	result := Integration("/usr/bin/zsh", map[string]string{}, root)
	if len(result.Args) != 0 {
		t.Fatalf("args = %v, want empty", result.Args)
	}
	want := map[string]string{"ZDOTDIR": filepath.Join(root, "zsh")}
	if !reflect.DeepEqual(result.Env, want) {
		t.Fatalf("env = %v, want %v", result.Env, want)
	}
}

func TestUserZdotdirCarriedThrough(t *testing.T) {
	root := writtenRoot(t)
	result := Integration("/bin/zsh", map[string]string{"ZDOTDIR": "/home/u/.config/zsh"}, root)
	want := map[string]string{
		"ZDOTDIR":            filepath.Join(root, "zsh"),
		"MUXUS_USER_ZDOTDIR": "/home/u/.config/zsh",
	}
	if !reflect.DeepEqual(result.Env, want) {
		t.Fatalf("env = %v, want %v", result.Env, want)
	}
}

func TestBashStartsWithInitFileShim(t *testing.T) {
	root := writtenRoot(t)
	result := Integration("/bin/bash", map[string]string{}, root)
	if !reflect.DeepEqual(result.Args, []string{"--init-file", filepath.Join(root, "bash-init.bash")}) {
		t.Fatalf("args = %v", result.Args)
	}
	if len(result.Env) != 0 {
		t.Fatalf("env = %v, want empty", result.Env)
	}
}

func TestOtherShellsUntouched(t *testing.T) {
	root := writtenRoot(t)
	result := Integration("/usr/bin/fish", map[string]string{}, root)
	if len(result.Args) != 0 || len(result.Env) != 0 {
		t.Fatalf("fish must spawn untouched, got %+v", result)
	}
}

func TestDegradesWithoutShimDir(t *testing.T) {
	result := Integration("/bin/zsh", map[string]string{}, "")
	if len(result.Args) != 0 || len(result.Env) != 0 {
		t.Fatalf("missing shim dir must disable integration, got %+v", result)
	}
}
