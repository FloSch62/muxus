package sshx

import (
	"math"
	"os"
	"os/user"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

// Resolution (what `ssh <host>` would use) and listing (the session
// manager's data), ported from the second half of ssh-config.ts.

// ResolvedTarget is the resolved settings plus connection tunables the shared
// DTO doesn't carry. The numeric fields are float64 because the TS engine
// accepted any non-negative finite Number.
type ResolvedTarget struct {
	api.ResolvedHostSettings
	ConnectTimeout      *float64
	ServerAliveInterval *float64
}

var cfgResolvedKeys = map[string]bool{
	"hostname":                 true,
	"user":                     true,
	"port":                     true,
	"identitiesonly":           true,
	"forwardagent":             true,
	"preferredauthentications": true,
	"pubkeyauthentication":     true,
	"connecttimeout":           true,
	"serveraliveinterval":      true,
}

func cfgYes(v string) bool { return strings.ToLower(v) == "yes" }

// ResolveHost resolves every option for host in ssh's sequential
// first-obtained-wins order. IdentityFile, CertificateFile and the *Forward
// directives accumulate instead. ProxyJump and ProxyCommand are mutually
// exclusive: whichever is obtained first wins, matching OpenSSH.
func ResolveHost(doc *ConfigDocument, host string) ResolvedTarget {
	first := map[string]string{}
	identityFiles := []string{}
	certificateFiles := []string{}
	forwards := []api.ConfigForward{}

	for _, entry := range doc.sequence {
		opts := entry.options
		if entry.block != nil {
			if !HostPatternsMatch(entry.block.Patterns, host) {
				continue
			}
			opts = entry.block.Options
		}
		for _, opt := range opts {
			switch opt.Key {
			case "identityfile":
				if f := cfgArg(opt.Args, 0); f != "" && !slices.Contains(identityFiles, f) {
					identityFiles = append(identityFiles, f)
				}
			case "certificatefile":
				if f := cfgArg(opt.Args, 0); f != "" && !slices.Contains(certificateFiles, f) {
					certificateFiles = append(certificateFiles, f)
				}
			case "proxyjump", "proxycommand":
				_, hasJump := first["proxyjump"]
				_, hasCommand := first["proxycommand"]
				if !hasJump && !hasCommand && opt.Value != "" {
					first[opt.Key] = opt.Value
				}
			case "localforward", "remoteforward", "dynamicforward":
				if fwd := ParseForwardOption(opt.Key, opt.Args); fwd != nil {
					forwards = append(forwards, *fwd)
				}
			default:
				if cfgResolvedKeys[opt.Key] && opt.Value != "" {
					if _, ok := first[opt.Key]; !ok {
						first[opt.Key] = opt.Value
					}
				}
			}
		}
	}

	requested := first["hostname"]
	if requested == "" {
		requested = host
	}
	hostname := cfgExpandHostTokens(requested, host)
	userName := first["user"]
	port := 22
	if p, ok := cfgParsePort(first["port"]); ok {
		port = p
	}
	preferred := first["preferredauthentications"]
	tokenR := userName
	if tokenR == "" {
		tokenR = cfgLocalUsername()
	}

	expandedIdentities := make([]string, 0, len(identityFiles))
	for _, f := range identityFiles {
		expandedIdentities = append(expandedIdentities, ExpandIdentityPath(f, hostname, tokenR))
	}
	expandedCertificates := make([]string, 0, len(certificateFiles))
	for _, f := range certificateFiles {
		expandedCertificates = append(expandedCertificates, ExpandIdentityPath(f, hostname, tokenR))
	}

	passwordOnly := strings.ToLower(first["pubkeyauthentication"]) == "no"
	if !passwordOnly && preferred != "" {
		passwordOnly = !slices.Contains(strings.Split(strings.ToLower(preferred), ","), "publickey")
	}

	return ResolvedTarget{
		ResolvedHostSettings: api.ResolvedHostSettings{
			Hostname:         hostname,
			User:             userName,
			Port:             port,
			IdentityFiles:    expandedIdentities,
			CertificateFiles: expandedCertificates,
			IdentitiesOnly:   cfgYes(first["identitiesonly"]),
			ForwardAgent:     cfgYes(first["forwardagent"]),
			ProxyJump:        ParseProxyJumpList(first["proxyjump"]),
			ProxyCommand:     cfgParseProxyCommand(first["proxycommand"]),
			Forwards:         forwards,
			PasswordOnly:     passwordOnly,
		},
		ConnectTimeout:      cfgParseNumberOpt(first, "connecttimeout"),
		ServerAliveInterval: cfgParseNumberOpt(first, "serveraliveinterval"),
	}
}

// cfgParseProxyCommand: a value of "none" (or nothing) means no command.
func cfgParseProxyCommand(value string) string {
	if value != "" && strings.ToLower(value) != "none" {
		return value
	}
	return ""
}

// cfgParsePort mirrors parsePort: a JS-Number integer in 1..65535.
func cfgParsePort(value string) (int, bool) {
	n := cfgJSNumber(value)
	if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) {
		return 0, false
	}
	if n > 0 && n < 65536 {
		return int(n), true
	}
	return 0, false
}

func cfgParseNumberOpt(first map[string]string, key string) *float64 {
	value, ok := first[key]
	if !ok {
		return nil
	}
	n := cfgJSNumber(value)
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return nil
	}
	return &n
}

// cfgDecimalRE is the JS decimal numeric-literal shape Number() accepts.
var cfgDecimalRE = regexp.MustCompile(`^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$`)

// cfgJSNumber mirrors JavaScript's Number() string coercion for the forms an
// ssh config can carry: decimal (fraction/exponent), 0x/0o/0b integers and
// Infinity. Unparseable input yields NaN, like Number().
func cfgJSNumber(value string) float64 {
	s := cfgTrim(value)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		var base int
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			if u, err := strconv.ParseUint(s[2:], base, 64); err == nil {
				return float64(u)
			}
			return math.NaN()
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if !cfgDecimalRE.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// ParseProxyJumpList: `ProxyJump a,user@b:2222,c` → hop specs in dialing
// order; `none` (or absent) → [].
func ParseProxyJumpList(value string) []string {
	out := []string{}
	if value == "" || strings.ToLower(value) == "none" {
		return out
	}
	for _, s := range strings.Split(value, ",") {
		if t := cfgTrim(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// HostSpec is `[user@]host[:port]` — a ProxyJump hop or quick-connect
// target. User "" and Port 0 mean absent.
type HostSpec struct {
	Host string
	User string
	Port int
}

// ParseHostSpec parses `[user@]host[:port]`.
func ParseHostSpec(spec string) HostSpec {
	rest := cfgTrim(spec)
	userName := ""
	if at := strings.LastIndex(rest, "@"); at > 0 {
		userName = rest[:at]
		rest = rest[at+1:]
	}
	// [v6::addr]:port / bare v6 addresses keep their colons.
	if m := cfgBracketSpecRE.FindStringSubmatch(rest); m != nil {
		port, _ := cfgParsePort(m[2])
		return HostSpec{Host: m[1], User: userName, Port: port}
	}
	if colon := strings.LastIndex(rest, ":"); colon > 0 && !strings.Contains(rest[:colon], ":") {
		if port, ok := cfgParsePort(rest[colon+1:]); ok {
			return HostSpec{Host: rest[:colon], User: userName, Port: port}
		}
	}
	return HostSpec{Host: rest, User: userName}
}

// cfgExpandHostTokens expands the %-tokens ssh allows in HostName
// (%h = originally requested name, %% = literal %).
func cfgExpandHostTokens(value, requestedHost string) string {
	return cfgHostTokenRE.ReplaceAllStringFunc(value, func(m string) string {
		if m == "%%" {
			return "%"
		}
		return requestedHost
	})
}

// ExpandIdentityPath expands ~ and the common %-tokens in an identity or
// certificate path: %% literal, %d home, %h resolved hostname, %r remote
// user, %u local username.
func ExpandIdentityPath(value, tokenH, tokenR string) string {
	home, _ := os.UserHomeDir()
	p := value
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		p = home + p[1:]
	}
	return cfgIdentTokenRE.ReplaceAllStringFunc(p, func(m string) string {
		switch m {
		case "%%":
			return "%"
		case "%d":
			return home
		case "%h":
			return tokenH
		case "%r":
			return tokenR
		}
		return cfgLocalUsername() // %u
	})
}

// cfgLocalUsername mirrors Node's os.userInfo().username.
func cfgLocalUsername() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		// Windows reports DOMAIN\name; Node reports the bare name.
		if i := strings.LastIndexByte(u.Username, '\\'); i >= 0 {
			return u.Username[i+1:]
		}
		return u.Username
	}
	if v := os.Getenv("USER"); v != "" {
		return v
	}
	return os.Getenv("USERNAME")
}

// ParseForwardOption parses a LocalForward/RemoteForward/DynamicForward
// option's arguments; key is the lowercased keyword.
func ParseForwardOption(key string, args []string) *api.ConfigForward {
	bindPort, ok := cfgParseListenPort(cfgArg(args, 0))
	if !ok {
		return nil
	}
	if key == "dynamicforward" {
		return &api.ConfigForward{Type: string(api.ForwardDynamic), BindPort: bindPort}
	}
	targetHost, targetPort, ok := cfgParseTargetSpec(cfgArg(args, 1))
	if !ok {
		return nil
	}
	kind := string(api.ForwardLocal)
	if key != "localforward" {
		kind = string(api.ForwardRemote)
	}
	return &api.ConfigForward{Type: kind, BindPort: bindPort, TargetHost: targetHost, TargetPort: targetPort}
}

// cfgParseListenPort parses `[bind_address:]port` (we always bind loopback;
// only the port matters).
func cfgParseListenPort(spec string) (int, bool) {
	if spec == "" {
		return 0, false
	}
	if idx := strings.LastIndex(spec, ":"); idx >= 0 {
		spec = spec[idx+1:]
	}
	return cfgParsePort(spec)
}

// cfgParseTargetSpec parses `host:port` or `host/port`.
func cfgParseTargetSpec(spec string) (string, int, bool) {
	if spec == "" {
		return "", 0, false
	}
	sepChar := ":"
	if strings.Contains(spec, "/") {
		sepChar = "/"
	}
	sep := strings.LastIndex(spec, sepChar)
	if sep <= 0 {
		return "", 0, false
	}
	port, ok := cfgParsePort(spec[sep+1:])
	host := strings.TrimSuffix(strings.TrimPrefix(spec[:sep], "["), "]")
	if host == "" || !ok {
		return "", 0, false
	}
	return host, port, true
}

// ---------------------------------------------------------------------------
// Listing (the session manager's data)
// ---------------------------------------------------------------------------

// BlockToOptions maps a block's own option lines to the editable DTO;
// unmodeled lines land in Extras.
func BlockToOptions(block *HostBlock) api.HostBlockOptions {
	out := api.HostBlockOptions{}
	extras := []api.HostExtraOption{}
	preferredConsumed := false
	proxyConsumed := false

	for _, opt := range block.Options {
		keep := func() {
			extras = append(extras, api.HostExtraOption{Keyword: opt.Keyword, Value: opt.Value})
		}
		switch opt.Key {
		case "hostname":
			if out.Hostname == nil {
				// No argument at all mirrors assigning undefined: still absent.
				if len(opt.Args) > 0 {
					v := opt.Args[0]
					out.Hostname = &v
				}
			} else {
				keep()
			}
		case "user":
			if out.User == nil {
				if len(opt.Args) > 0 {
					v := opt.Args[0]
					out.User = &v
				}
			} else {
				keep()
			}
		case "port":
			if p, ok := cfgParsePort(cfgArg(opt.Args, 0)); ok && out.Port == nil {
				out.Port = &p
			} else {
				keep()
			}
		case "identityfile":
			if f := cfgArg(opt.Args, 0); f != "" {
				out.IdentityFiles = append(out.IdentityFiles, f)
			}
		case "certificatefile":
			if f := cfgArg(opt.Args, 0); f != "" {
				out.CertificateFiles = append(out.CertificateFiles, f)
			}
		case "identitiesonly":
			v := cfgYes(cfgArg(opt.Args, 0))
			out.IdentitiesOnly = &v
		case "forwardagent":
			v := cfgYes(cfgArg(opt.Args, 0))
			out.ForwardAgent = &v
		case "proxyjump":
			if !proxyConsumed {
				out.ProxyJump = ParseProxyJumpList(opt.Value)
				proxyConsumed = true
			} else {
				keep()
			}
		case "proxycommand":
			if !proxyConsumed {
				if command := cfgParseProxyCommand(opt.Value); command != "" {
					out.ProxyCommand = &command
				} else {
					keep()
				}
				proxyConsumed = true
			} else {
				keep()
			}
		case "localforward", "remoteforward", "dynamicforward":
			if fwd := ParseForwardOption(opt.Key, opt.Args); fwd != nil {
				out.Forwards = append(out.Forwards, *fwd)
			} else {
				keep()
			}
		case "pubkeyauthentication":
			if strings.ToLower(cfgArg(opt.Args, 0)) == "no" {
				out.PasswordOnly = true
			} else {
				keep()
			}
		case "preferredauthentications":
			// Our canonical passwordOnly pair; anything else is a
			// hand-written policy.
			if strings.ToLower(opt.Value) == "keyboard-interactive,password" {
				preferredConsumed = true
			} else {
				keep()
			}
		default:
			keep()
		}
	}
	if preferredConsumed && !out.PasswordOnly {
		// PreferredAuthentications without PubkeyAuthentication no — preserve it.
		extras = append(extras, api.HostExtraOption{Keyword: "PreferredAuthentications", Value: "keyboard-interactive,password"})
	}
	if len(extras) > 0 {
		out.Extras = extras
	}
	return out
}

// ListHosts lists the concrete Host aliases with block options and resolved
// settings; the first block naming an alias owns it.
func ListHosts(doc *ConfigDocument) []api.SSHHostEntry {
	seen := map[string]bool{}
	entries := []api.SSHHostEntry{}
	for _, block := range doc.Blocks {
		concrete := []string{}
		for _, p := range block.Patterns {
			if IsConcreteAlias(p) {
				concrete = append(concrete, p)
			}
		}
		fresh := []string{}
		for _, a := range concrete {
			if !seen[a] {
				fresh = append(fresh, a)
			}
		}
		if len(fresh) == 0 {
			continue
		}
		for _, a := range concrete {
			seen[a] = true
		}
		alias := fresh[0]
		resolved := ResolveHost(doc, alias)
		entries = append(entries, api.SSHHostEntry{
			Alias:       alias,
			Aliases:     concrete,
			Description: block.Description,
			File:        block.File,
			Options:     BlockToOptions(block),
			// ResolvedTarget's extra tunables are intentionally dropped here,
			// like the TS listing.
			Resolved: resolved.ResolvedHostSettings,
		})
	}
	return entries
}
