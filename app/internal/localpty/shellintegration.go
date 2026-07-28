package localpty

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Shell integration for local terminals: rc shims that report the command
// lifecycle via OSC 133 (FinalTerm) — D;<exit code> when a command finishes,
// C when one starts — which the client turns into failed-command marks in
// the scrollbar, the same mechanism VS Code uses. The shims source the
// user's own startup files first, so prompts and plugins are untouched.
// Content ported verbatim from server/src/local/shell-integration.ts.

const Zshenv = `# Muxus shell integration bootstrap. Sources your own .zshenv unmodified,
# then returns to the shim so .zshrc can hook in.
__muxus_shim="$ZDOTDIR"
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
if [[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]]; then builtin source "${ZDOTDIR:-$HOME}/.zshenv"; fi
if [[ -n "$ZDOTDIR" ]]; then MUXUS_USER_ZDOTDIR="$ZDOTDIR"; else builtin unset MUXUS_USER_ZDOTDIR; fi
ZDOTDIR="$__muxus_shim"
builtin unset __muxus_shim
`

const Zshrc = `# Muxus shell integration. Your .zshrc runs first, unmodified.
if [[ -n "$MUXUS_USER_ZDOTDIR" ]]; then ZDOTDIR="$MUXUS_USER_ZDOTDIR"; else builtin unset ZDOTDIR; fi
builtin unset MUXUS_USER_ZDOTDIR
if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then builtin source "${ZDOTDIR:-$HOME}/.zshrc"; fi

if [[ -o interactive && -z "$__muxus_integrated" ]]; then
  builtin typeset -g __muxus_integrated=1
  builtin autoload -Uz add-zsh-hook
  __muxus_precmd() {
    local __muxus_status=$?
    builtin printf '\e]133;D;%s\a' "$__muxus_status"
    builtin printf '\e]133;A\a'
  }
  __muxus_preexec() {
    builtin printf '\e]133;C\a'
  }
  add-zsh-hook precmd __muxus_precmd
  add-zsh-hook preexec __muxus_preexec
fi
`

const bashInit = `# Muxus shell integration. Your normal startup files run first, unmodified.
if [[ -f /etc/bash.bashrc ]]; then . /etc/bash.bashrc; fi
if [[ -f "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; fi

if [[ $- == *i* && -z "$__muxus_integrated" ]]; then
  __muxus_integrated=1
  __muxus_prompt_mark() {
    local __muxus_status=$?
    printf '\e]133;D;%s\a' "$__muxus_status"
    printf '\e]133;A\a'
  }
  # PS0 expands once per executed command (never for an empty prompt), which
  # makes it a preexec without the DEBUG-trap fragility.
  PS0="\[\e]133;C\a\]${PS0-}"
  PROMPT_COMMAND="__muxus_prompt_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`

var integrationFiles = []struct {
	rel     string
	content string
}{
	{"zsh/.zshenv", Zshenv},
	{"zsh/.zshrc", Zshrc},
	{"bash-init.bash", bashInit},
}

// WriteIntegrationFiles writes the shim files under root (idempotent).
func WriteIntegrationFiles(root string) error {
	if err := os.MkdirAll(filepath.Join(root, "zsh"), 0o700); err != nil {
		return err
	}
	for _, f := range integrationFiles {
		if err := os.WriteFile(filepath.Join(root, f.rel), []byte(f.content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

var (
	rootOnce   sync.Once
	cachedRoot string
)

// IntegrationRoot returns the shim directory (written once per process);
// empty when unavailable.
func IntegrationRoot() string {
	rootOnce.Do(func() {
		base := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME"))
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return
			}
			base = filepath.Join(home, ".cache")
		}
		root := filepath.Join(base, "muxus", "shell-integration")
		if err := WriteIntegrationFiles(root); err != nil {
			return
		}
		cachedRoot = root
	})
	return cachedRoot
}

// ShellIntegration carries the spawn arguments and env that switch
// integration on for a given shell. Unrecognized shells spawn untouched
// (fish emits OSC 133 on its own).
type ShellIntegration struct {
	Args []string
	Env  map[string]string
}

func Integration(shell string, baseEnv map[string]string, root string) ShellIntegration {
	none := ShellIntegration{Args: []string{}, Env: map[string]string{}}
	if runtime.GOOS == "windows" || root == "" {
		return none
	}
	switch filepath.Base(shell) {
	case "zsh":
		env := map[string]string{"ZDOTDIR": filepath.Join(root, "zsh")}
		if userZdotdir := strings.TrimSpace(baseEnv["ZDOTDIR"]); userZdotdir != "" {
			env["MUXUS_USER_ZDOTDIR"] = userZdotdir
		}
		return ShellIntegration{Args: []string{}, Env: env}
	case "bash":
		return ShellIntegration{Args: []string{"--init-file", filepath.Join(root, "bash-init.bash")}, Env: map[string]string{}}
	}
	return none
}
