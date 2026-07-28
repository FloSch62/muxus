package sshx

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

// Editing side of the ssh_config engine, ported from ssh-config-edit.ts:
// serialize a Host block from the editor's DTO and splice it into the user's
// config files, touching nothing but the edited block's lines. Every write is
// atomic (tmp + rename), keeps the file's mode, and leaves a `.muxus.bak`
// copy of the previous content.

var (
	cfgAliasRE   = regexp.MustCompile(`^[^` + cfgSpaceClass + `#*?!]+$`)
	cfgKeywordRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)
	// cfgJumpHostRejectRE mirrors /[\s,]/.
	cfgJumpHostRejectRE = regexp.MustCompile(`[` + cfgSpaceClass + `,]`)
	cfgIndentRE         = regexp.MustCompile(`^([ \t]+)[^` + cfgSpaceClass + `]`)
)

// cfgForbiddenExtras are keywords that would change the file's structure if
// smuggled in via extras.
var cfgForbiddenExtras = map[string]bool{"host": true, "match": true}

// ConfigProblem mirrors HttpProblem for the config editor: the HTTP status a
// route should answer with, plus an optional machine-readable code.
type ConfigProblem struct {
	Status  int
	Code    string
	Message string
}

func (p *ConfigProblem) Error() string { return p.Message }

func cfgBad(message string) *ConfigProblem {
	return &ConfigProblem{Status: 400, Message: message}
}

// UpsertResult mirrors UpsertResult.
type UpsertResult struct {
	File string `json:"file"`
}

// FindHostBlock returns the first block whose Host line names alias as a
// concrete pattern.
func FindHostBlock(doc *ConfigDocument, alias string) *HostBlock {
	for _, b := range doc.Blocks {
		for _, p := range b.Patterns {
			if IsConcreteAlias(p) && p == alias {
				return b
			}
		}
	}
	return nil
}

// UpsertHost creates or replaces a Host block, writing only the affected
// files.
func UpsertHost(req api.HostUpsertRequest, rootPath string) (UpsertResult, error) {
	if err := cfgValidateUpsert(req); err != nil {
		return UpsertResult{}, err
	}
	doc := LoadConfigDocument(rootPath)

	var block *HostBlock
	if req.PreviousAlias != "" {
		block = FindHostBlock(doc, req.PreviousAlias)
		if block == nil {
			return UpsertResult{}, &ConfigProblem{Status: 404, Message: fmt.Sprintf("no Host block for \"%s\" in %s", req.PreviousAlias, filepath.Base(doc.RootPath))}
		}
	}
	for _, alias := range req.Aliases {
		if other := FindHostBlock(doc, alias); other != nil && other != block {
			return UpsertResult{}, &ConfigProblem{Status: 409, Code: "host-exists", Message: fmt.Sprintf("Host \"%s\" already exists in %s", alias, filepath.Base(other.File))}
		}
	}

	targetFile, err := cfgResolveTargetFile(cfgRequestedFile(req, block, doc), doc.RootPath)
	if err != nil {
		return UpsertResult{}, err
	}
	rendered := RenderHostBlock(req, cfgDetectIndent(doc, targetFile), cfgExtraPatterns(block))

	changed := []string{}
	mark := func(f string) {
		if !slices.Contains(changed, f) {
			changed = append(changed, f)
		}
	}
	if block != nil && block.File == targetFile {
		doc.Files[block.File] = cfgSplice(doc.Files[block.File], block.CommentStart, block.End-block.CommentStart, rendered)
		mark(block.File)
	} else {
		if block != nil {
			cfgRemoveBlock(doc, block)
			mark(block.File)
		}
		cfgAppendBlock(doc, targetFile, rendered)
		mark(targetFile)
		if cfgEnsureIncluded(doc, targetFile) {
			mark(doc.RootPath)
		}
	}

	for _, file := range changed {
		if err := cfgWriteConfigFile(file, doc.Files[file]); err != nil {
			return UpsertResult{}, err
		}
	}
	return UpsertResult{File: targetFile}, nil
}

// DeleteHost removes a Host block (and its prelude comment) from its file.
func DeleteHost(alias string, rootPath string) error {
	doc := LoadConfigDocument(rootPath)
	block := FindHostBlock(doc, alias)
	if block == nil {
		return &ConfigProblem{Status: 404, Message: fmt.Sprintf("no Host block for \"%s\"", alias)}
	}
	cfgRemoveBlock(doc, block)
	return cfgWriteConfigFile(block.File, doc.Files[block.File])
}

// PreviewHost returns the exact text UpsertHost would write, for the
// editor's live preview.
func PreviewHost(req api.HostUpsertRequest, rootPath string) (string, error) {
	if err := cfgValidateUpsert(req); err != nil {
		return "", err
	}
	doc := LoadConfigDocument(rootPath)
	var block *HostBlock
	if req.PreviousAlias != "" {
		block = FindHostBlock(doc, req.PreviousAlias)
	}
	targetFile, err := cfgResolveTargetFile(cfgRequestedFile(req, block, doc), doc.RootPath)
	if err != nil {
		return "", err
	}
	return strings.Join(RenderHostBlock(req, cfgDetectIndent(doc, targetFile), cfgExtraPatterns(block)), "\n"), nil
}

// cfgRequestedFile mirrors `req.file ?? block?.file ?? doc.rootPath`.
func cfgRequestedFile(req api.HostUpsertRequest, block *HostBlock, doc *ConfigDocument) string {
	if req.File != nil {
		return *req.File
	}
	if block != nil {
		return block.File
	}
	return doc.RootPath
}

// cfgExtraPatterns keeps wildcard/negation patterns sharing the edited
// block's Host line alive across edits.
func cfgExtraPatterns(block *HostBlock) []string {
	extra := []string{}
	if block != nil {
		for _, p := range block.Patterns {
			if !IsConcreteAlias(p) {
				extra = append(extra, p)
			}
		}
	}
	return extra
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

func cfgValidateUpsert(req api.HostUpsertRequest) error {
	if len(req.Aliases) == 0 {
		return cfgBad("at least one alias is required")
	}
	for _, alias := range req.Aliases {
		if !cfgAliasRE.MatchString(alias) {
			return cfgBad(fmt.Sprintf("invalid alias \"%s\" — no spaces, wildcards or \"!\"", alias))
		}
	}
	o := req.Options
	singleTokens := []*string{o.Hostname, o.User}
	for _, v := range o.IdentityFiles {
		singleTokens = append(singleTokens, &v)
	}
	for _, v := range o.CertificateFiles {
		singleTokens = append(singleTokens, &v)
	}
	for _, v := range singleTokens {
		// These are re-quoted as single tokens on render, so quotes can't nest.
		if v != nil && (cfgTrim(*v) == "" || strings.ContainsAny(*v, "\r\n\"")) {
			return cfgBad("option values must be non-empty single-line text without quotes")
		}
	}
	if o.Port != nil && !(*o.Port > 0 && *o.Port < 65536) {
		return cfgBad("port must be 1–65535")
	}
	for _, hop := range o.ProxyJump {
		if cfgTrim(hop) == "" || cfgJumpHostRejectRE.MatchString(hop) {
			return cfgBad(fmt.Sprintf("invalid jump host \"%s\"", hop))
		}
	}
	if o.ProxyCommand != nil && (cfgTrim(*o.ProxyCommand) == "" || strings.ContainsAny(*o.ProxyCommand, "\r\n")) {
		return cfgBad("ProxyCommand must be non-empty single-line text")
	}
	if o.ProxyCommand != nil && o.ProxyJump != nil {
		return cfgBad("ProxyJump and ProxyCommand are mutually exclusive")
	}
	for _, f := range o.Forwards {
		if err := cfgValidateForward(f); err != nil {
			return err
		}
	}
	for _, extra := range o.Extras {
		if !cfgKeywordRE.MatchString(extra.Keyword) || cfgForbiddenExtras[strings.ToLower(extra.Keyword)] {
			return cfgBad(fmt.Sprintf("invalid option keyword \"%s\"", extra.Keyword))
		}
		// Extras are written verbatim (they may carry their own quoting) —
		// only newlines are off-limits.
		if strings.ContainsAny(extra.Value, "\r\n") {
			return cfgBad(fmt.Sprintf("invalid value for %s", extra.Keyword))
		}
	}
	return nil
}

func cfgValidateForward(f api.ConfigForward) error {
	portOk := func(p int) bool { return p > 0 && p < 65536 }
	if !portOk(f.BindPort) {
		return cfgBad("forward listen port must be 1–65535")
	}
	if f.Type == string(api.ForwardDynamic) {
		return nil
	}
	if cfgTrim(f.TargetHost) == "" || cfgSpaceRE.MatchString(f.TargetHost) {
		return cfgBad("forward target host is required")
	}
	if !portOk(f.TargetPort) {
		return cfgBad("forward target port must be 1–65535")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

// cfgQuoteToken quotes one token when it contains whitespace. Never applied
// to multi-arg values.
func cfgQuoteToken(v string) string {
	if cfgSpaceRE.MatchString(v) {
		return `"` + v + `"`
	}
	return v
}

func cfgForwardTarget(host string, port int) string {
	if strings.Contains(host, ":") {
		return "[" + host + "]:" + strconv.Itoa(port)
	}
	return host + ":" + strconv.Itoa(port)
}

func cfgYesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// RenderHostBlock serializes the editor DTO into the block's exact lines.
func RenderHostBlock(req api.HostUpsertRequest, indent string, extraPatterns []string) []string {
	lines := []string{}
	description := cfgTrim(strings.ReplaceAll(req.Description, "\r", ""))
	if description != "" {
		for _, line := range strings.Split(description, "\n") {
			if t := cfgTrim(line); t != "" {
				lines = append(lines, "# "+t)
			} else {
				lines = append(lines, "#")
			}
		}
	}
	patterns := append(append([]string{}, req.Aliases...), extraPatterns...)
	lines = append(lines, "Host "+strings.Join(patterns, " "))
	opt := func(keyword, value string) {
		if value != "" {
			lines = append(lines, indent+keyword+" "+value)
		}
	}
	singleToken := func(v *string) string {
		if v == nil {
			return ""
		}
		return cfgQuoteToken(cfgTrim(*v))
	}

	o := req.Options
	opt("HostName", singleToken(o.Hostname))
	opt("User", singleToken(o.User))
	if o.Port != nil {
		opt("Port", strconv.Itoa(*o.Port))
	}
	for _, file := range o.IdentityFiles {
		opt("IdentityFile", cfgQuoteToken(cfgTrim(file)))
	}
	for _, file := range o.CertificateFiles {
		opt("CertificateFile", cfgQuoteToken(cfgTrim(file)))
	}
	if o.IdentitiesOnly != nil {
		opt("IdentitiesOnly", cfgYesNo(*o.IdentitiesOnly))
	}
	if o.ProxyJump != nil {
		if len(o.ProxyJump) > 0 {
			opt("ProxyJump", strings.Join(o.ProxyJump, ","))
		} else {
			opt("ProxyJump", "none")
		}
	}
	if o.ProxyCommand != nil {
		opt("ProxyCommand", cfgTrim(*o.ProxyCommand))
	}
	if o.ForwardAgent != nil {
		opt("ForwardAgent", cfgYesNo(*o.ForwardAgent))
	}
	if o.PasswordOnly {
		opt("PubkeyAuthentication", "no")
		opt("PreferredAuthentications", "keyboard-interactive,password")
	}
	for _, f := range o.Forwards {
		switch f.Type {
		case string(api.ForwardDynamic):
			opt("DynamicForward", strconv.Itoa(f.BindPort))
		case string(api.ForwardLocal):
			opt("LocalForward", strconv.Itoa(f.BindPort)+" "+cfgForwardTarget(f.TargetHost, f.TargetPort))
		default:
			// Anything non-local, non-dynamic renders as RemoteForward,
			// mirroring the TS ternary.
			opt("RemoteForward", strconv.Itoa(f.BindPort)+" "+cfgForwardTarget(f.TargetHost, f.TargetPort))
		}
	}
	for _, extra := range o.Extras {
		opt(extra.Keyword, cfgTrim(extra.Value))
	}
	return lines
}

// cfgDetectIndent matches the file's existing option indentation; defaults
// to two spaces.
func cfgDetectIndent(doc *ConfigDocument, file string) string {
	for _, line := range doc.Files[file] {
		if m := cfgIndentRE.FindStringSubmatch(line); m != nil {
			return m[1]
		}
	}
	return "  "
}

// ---------------------------------------------------------------------------
// File surgery
// ---------------------------------------------------------------------------

// cfgResolveTargetFile keeps config edits inside the root config's directory
// (normally ~/.ssh).
func cfgResolveTargetFile(file, rootPath string) (string, error) {
	resolved := cfgAbs(file)
	rel, err := filepath.Rel(filepath.Dir(rootPath), resolved)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", &ConfigProblem{Status: 400, Message: fmt.Sprintf("config files must live under %s", filepath.Dir(rootPath))}
	}
	return resolved, nil
}

func cfgSplice(lines []string, start, count int, insert []string) []string {
	out := make([]string, 0, len(lines)-count+len(insert))
	out = append(out, lines[:start]...)
	out = append(out, insert...)
	out = append(out, lines[start+count:]...)
	return out
}

func cfgLineAt(lines []string, i int) string {
	if i >= 0 && i < len(lines) {
		return lines[i]
	}
	return ""
}

func cfgRemoveBlock(doc *ConfigDocument, block *HostBlock) {
	lines := cfgSplice(doc.Files[block.File], block.CommentStart, block.End-block.CommentStart, nil)
	// Collapse the blank seam the removal leaves behind.
	at := block.CommentStart
	if at < len(lines) && cfgTrim(cfgLineAt(lines, at)) == "" && (at == 0 || cfgTrim(cfgLineAt(lines, at-1)) == "") {
		lines = cfgSplice(lines, at, 1, nil)
	}
	for len(lines) > 0 && cfgTrim(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	doc.Files[block.File] = lines
}

func cfgAppendBlock(doc *ConfigDocument, file string, rendered []string) {
	lines := doc.Files[file]
	if len(lines) > 0 && cfgTrim(lines[len(lines)-1]) != "" {
		lines = append(lines, "")
	}
	lines = append(lines, rendered...)
	doc.Files[file] = lines
}

// cfgEnsureIncluded is a reachable-from-root check; adds an Include to the
// root config when needed.
func cfgEnsureIncluded(doc *ConfigDocument, targetFile string) bool {
	if targetFile == doc.RootPath || slices.Contains(doc.FileOrder, targetFile) {
		return false
	}
	rootLines := doc.Files[doc.RootPath]
	rel, err := filepath.Rel(filepath.Dir(doc.RootPath), targetFile)
	if err != nil {
		rel = targetFile
	}
	// Insert before the first directive (appending could land inside the last
	// Host block, where Include has per-block semantics). Top placement is
	// the conventional spot for Includes in per-user configs.
	at := 0
	for at < len(rootLines) {
		t := cfgTrim(rootLines[at])
		if t != "" && !strings.HasPrefix(t, "#") {
			break
		}
		at++
	}
	doc.Files[doc.RootPath] = cfgSplice(rootLines, at, 0, []string{"Include " + rel, ""})
	return true
}

func cfgWriteConfigFile(filePath string, lines []string) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(filePath); err == nil {
		mode = st.Mode().Perm()
		// Best-effort backup of the previous content, like the TS
		// copyFileSync path; a new file has nothing to back up.
		if data, err := os.ReadFile(filePath); err == nil {
			bak := filePath + ".muxus.bak"
			if err := os.WriteFile(bak, data, 0o600); err == nil {
				_ = os.Chmod(bak, 0o600)
			}
		}
	}
	content := ""
	if len(lines) > 0 {
		content = strings.Join(lines, "\n") + "\n"
	}
	tmp := filePath + ".muxus.tmp"
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return err
	}
	return os.Rename(tmp, filePath)
}
