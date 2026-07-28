// Package sshx ports the server's OpenSSH per-user config engine
// (server/src/ssh/ssh-config.ts and ssh-config-edit.ts). OpenSSH files remain
// the interoperable source for connection details while Muxus owns UI
// metadata separately, so this package does three jobs:
//
//   - parse the config (and its Includes) into a *line-preserving* document,
//     so Host blocks can be edited in place without disturbing anything else
//     (see sshconfig_edit.go);
//   - list the concrete Host aliases for the session manager, each with the
//     block's own options plus the fully resolved effective settings;
//   - resolve any target the way `ssh` would: sequential first-obtained-wins
//     option lookup across matching Host patterns, accumulating IdentityFile,
//     CertificateFile and *Forward directives.
//
// Known deviations from ssh_config(5): Match blocks are skipped (their
// conditions need runtime state we don't have), and Include inside a Host
// block is preserved verbatim instead of expanded.
package sshx

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
)

const cfgMaxIncludeDepth = 8

// cfgSpaceClass is ECMAScript's \s character set (WhiteSpace ∪
// LineTerminator). The TS engine used \s and String.trim() throughout, so
// whitespace handling — including NBSP and BOM — must match byte for byte.
const cfgSpaceClass = `\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

var (
	// cfgLineRE mirrors /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*(.*?)\s*$/ with
	// JS semantics for both \s and the dot (which excludes  / ).
	cfgLineRE = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]*)[` + cfgSpaceClass + `]*(?:=|[` + cfgSpaceClass + `])[` + cfgSpaceClass + `]*([^\n\r\x{2028}\x{2029}]*?)[` + cfgSpaceClass + `]*$`)
	// cfgArgTokenRE mirrors /"([^"]*)"|(\S+)/g.
	cfgArgTokenRE = regexp.MustCompile(`"([^"]*)"|([^` + cfgSpaceClass + `]+)`)
	// cfgSpaceRE mirrors /\s/.
	cfgSpaceRE       = regexp.MustCompile(`[` + cfgSpaceClass + `]`)
	cfgPreludeStrip  = regexp.MustCompile(`^#[` + cfgSpaceClass + `]?`)
	cfgHostTokenRE   = regexp.MustCompile(`%[%h]`)
	cfgIdentTokenRE  = regexp.MustCompile(`%[%dhur]`)
	cfgBracketSpecRE = regexp.MustCompile(`^\[([^\]]+)\](?::([0-9]+))?$`)
)

func cfgIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// cfgTrim mirrors String.prototype.trim (same set as cfgSpaceClass).
func cfgTrim(s string) string { return strings.TrimFunc(s, cfgIsSpace) }

// DefaultConfigPath returns ~/.ssh/config — the OpenSSH per-user config
// location on macOS, Linux and Windows.
func DefaultConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh", "config")
}

// OptionLine is one `Keyword value` line inside a block, with original casing
// preserved.
type OptionLine struct {
	// Keyword as written ("HostName").
	Keyword string
	// Key is the lowercased keyword for comparisons.
	Key string
	// Value is the raw value text (quotes stripped only in Args).
	Value string
	Args  []string
}

// HostBlock is a `Host` block tied to its exact lines in one file.
type HostBlock struct {
	File string
	// CommentStart is the index of the first prelude comment line
	// (== HostLine when none).
	CommentStart int
	HostLine     int
	// End is the exclusive end of the block's lines in its file.
	End      int
	Patterns []string
	Options  []OptionLine
	// Description is the prelude comment text with leading "# " stripped,
	// newline-joined; empty when there is none.
	Description string
}

// cfgSequenceEntry is a config entry in evaluation order: a Host block or an
// unconditional top-level run. A block entry reads patterns and options
// through the block pointer so options accumulated during parsing stay
// shared, as the TS version shared the same array.
type cfgSequenceEntry struct {
	// block non-nil ⇒ a Host entry; nil ⇒ applies to every host.
	block   *HostBlock
	options []OptionLine
}

// ConfigDocument is the parsed, line-preserving view of a config and its
// includes.
type ConfigDocument struct {
	RootPath string
	// Files maps path → file lines, for every file that was read.
	Files map[string][]string
	// FileOrder lists files in evaluation order (root first). Includes the
	// root even if absent.
	FileOrder []string
	Blocks    []*HostBlock
	sequence  []*cfgSequenceEntry
	// Error is the first problem encountered (unreadable include, …);
	// content may be partial.
	Error string
}

type cfgParseState struct {
	doc     *ConfigDocument
	visited map[string]bool
	// includeBase: per ssh_config(5), relative Include paths resolve against
	// the root config's directory — even from included files.
	includeBase string
}

// LoadConfigDocument parses rootPath and every reachable Include.
func LoadConfigDocument(rootPath string) *ConfigDocument {
	doc := &ConfigDocument{
		RootPath: cfgAbs(rootPath),
		Files:    map[string][]string{},
	}
	state := &cfgParseState{
		doc:         doc,
		visited:     map[string]bool{},
		includeBase: filepath.Dir(cfgAbs(rootPath)),
	}
	cfgParseFile(doc.RootPath, state, 0)
	if !slices.Contains(doc.FileOrder, doc.RootPath) {
		doc.FileOrder = append([]string{doc.RootPath}, doc.FileOrder...)
	}
	return doc
}

func cfgAbs(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return filepath.Clean(p)
}

func cfgRecordError(state *cfgParseState, message string) {
	if state.doc.Error == "" {
		state.doc.Error = message
	}
}

// cfgSplitLines mirrors text.split(/\r?\n/) plus the trailing-newline drop: a
// final "" element is removed so appends don't create gaps (serialization
// always re-adds the final newline).
func cfgSplitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	if len(lines) > 1 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func cfgParseFile(file string, state *cfgParseState, depth int) {
	resolved := cfgAbs(file)
	if state.visited[resolved] || depth > cfgMaxIncludeDepth {
		return
	}
	state.visited[resolved] = true

	raw, err := os.ReadFile(resolved)
	if err != nil {
		// The root config's absence is normal; broken includes are worth
		// surfacing.
		if depth > 0 {
			cfgRecordError(state, fmt.Sprintf("could not read included file %s: %v", resolved, err))
		}
		return
	}

	lines := cfgSplitLines(string(raw))
	state.doc.Files[resolved] = lines
	state.doc.FileOrder = append(state.doc.FileOrder, resolved)

	var block *HostBlock
	inMatch := false
	var globals *cfgSequenceEntry

	for i, rawLine := range lines {
		line := cfgTrim(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := cfgLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		keyword := m[1]
		key := strings.ToLower(keyword)
		value := m[2]
		option := OptionLine{Keyword: keyword, Key: key, Value: value, Args: SplitArgs(value)}

		switch {
		case key == "host":
			commentStart := cfgScanPreludeComments(lines, i)
			patterns := make([]string, 0, len(option.Args))
			for _, p := range option.Args {
				if p != "" {
					patterns = append(patterns, p)
				}
			}
			block = &HostBlock{
				File:         resolved,
				CommentStart: commentStart,
				HostLine:     i,
				End:          i + 1,
				Patterns:     patterns,
				Description:  cfgPreludeText(lines, commentStart, i),
			}
			state.doc.Blocks = append(state.doc.Blocks, block)
			state.doc.sequence = append(state.doc.sequence, &cfgSequenceEntry{block: block})
			inMatch = false
			globals = nil
		case key == "match":
			block = nil
			inMatch = true
			globals = nil
		case key == "include" && block == nil && !inMatch:
			for _, pattern := range option.Args {
				for _, included := range cfgExpandIncludePath(pattern, state.includeBase) {
					cfgParseFile(included, state, depth+1)
				}
			}
			globals = nil // included content interleaves; keep evaluation order exact
		case inMatch:
			// Match-conditioned options are runtime-dependent; skip.
		case block != nil:
			block.Options = append(block.Options, option)
			block.End = i + 1
		default:
			if globals == nil {
				globals = &cfgSequenceEntry{}
				state.doc.sequence = append(state.doc.sequence, globals)
			}
			globals.options = append(globals.options, option)
		}
	}
}

// cfgScanPreludeComments walks back over the contiguous `#` lines directly
// above a Host line.
func cfgScanPreludeComments(lines []string, hostLine int) int {
	j := hostLine - 1
	for j >= 0 && strings.HasPrefix(cfgTrim(lines[j]), "#") {
		j--
	}
	return j + 1
}

func cfgPreludeText(lines []string, commentStart, hostLine int) string {
	if commentStart >= hostLine {
		return ""
	}
	parts := make([]string, 0, hostLine-commentStart)
	for _, l := range lines[commentStart:hostLine] {
		parts = append(parts, cfgPreludeStrip.ReplaceAllString(cfgTrim(l), ""))
	}
	return cfgTrim(strings.Join(parts, "\n"))
}

// SplitArgs splits a config value into tokens, honoring double quotes.
func SplitArgs(value string) []string {
	out := []string{}
	for _, m := range cfgArgTokenRE.FindAllStringSubmatchIndex(value, -1) {
		if m[2] >= 0 {
			// Quoted token — may be empty, which is still a token.
			out = append(out, value[m[2]:m[3]])
		} else {
			out = append(out, value[m[4]:m[5]])
		}
	}
	return out
}

func cfgArg(args []string, i int) string {
	if i < len(args) {
		return args[i]
	}
	return ""
}

// ---------------------------------------------------------------------------
// Pattern matching (ssh_config PATTERNS)
// ---------------------------------------------------------------------------

var (
	cfgGlobMu    sync.Mutex
	cfgGlobCache = map[string]*regexp.Regexp{}
)

func cfgGlobMatch(pattern, text string) bool {
	cfgGlobMu.Lock()
	rx, ok := cfgGlobCache[pattern]
	if !ok {
		var b strings.Builder
		b.WriteString("^")
		for _, r := range pattern {
			switch r {
			case '*':
				b.WriteString(".*")
			case '?':
				b.WriteString(".")
			case '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			default:
				b.WriteRune(r)
			}
		}
		b.WriteString("$")
		// Compile cannot fail for a fully escaped pattern; nil is cached as
		// never-matching just in case.
		rx, _ = regexp.Compile(b.String())
		cfgGlobCache[pattern] = rx
	}
	cfgGlobMu.Unlock()
	return rx != nil && rx.MatchString(text)
}

// HostPatternsMatch matches a Host line's pattern list: any positive match,
// unless a negation matches.
func HostPatternsMatch(patterns []string, host string) bool {
	matched := false
	for _, p := range patterns {
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "!") {
			if cfgGlobMatch(p[1:], host) {
				return false
			}
		} else if cfgGlobMatch(p, host) {
			matched = true
		}
	}
	return matched
}

// IsConcreteAlias reports a concrete, connectable alias: no wildcards, not a
// negation.
func IsConcreteAlias(pattern string) bool {
	return pattern != "" && !strings.HasPrefix(pattern, "!") && !strings.ContainsAny(pattern, "*?")
}

// ---------------------------------------------------------------------------
// Include expansion
// ---------------------------------------------------------------------------

// cfgExpandIncludePath resolves an Include argument to concrete files,
// supporting `~` and filename-level `*`/`?` globs.
func cfgExpandIncludePath(pattern, includeBase string) []string {
	p := cfgExpandTilde(pattern)
	if !filepath.IsAbs(p) {
		p = filepath.Join(includeBase, p)
	}
	name := filepath.Base(p)
	if !strings.ContainsAny(name, "*?") {
		return []string{p}
	}
	dir := filepath.Dir(p)
	var b strings.Builder
	b.WriteString("^")
	for _, r := range name {
		switch r {
		case '*':
			b.WriteString(`[^/\\]*`)
		case '?':
			b.WriteString(".")
		case '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteString("$")
	rx, err := regexp.Compile(b.String())
	if err != nil {
		return []string{}
	}
	list, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, e := range list {
		if rx.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	out := make([]string, 0, len(names))
	for _, n := range names {
		out = append(out, filepath.Join(dir, n))
	}
	return out
}

// cfgExpandTilde mirrors /^~(?=$|[\\/])/ → homedir.
func cfgExpandTilde(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, _ := os.UserHomeDir()
		return home + p[1:]
	}
	return p
}
