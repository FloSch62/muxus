package api

import (
	"bytes"
	"encoding/json"
)

// Opt models a JSON field with three states: absent, explicit null, and a
// value. Patch DTOs need the distinction because absent means "keep the
// stored value" while null means "clear it".
type Opt[T any] struct {
	// Set reports that the field was present in the JSON document.
	Set bool
	// Valid reports that the field carried a value rather than null.
	Valid bool
	Value T
}

// Some wraps a value as a present, non-null field.
func Some[T any](value T) Opt[T] { return Opt[T]{Set: true, Valid: true, Value: value} }

// Null is a present field carrying an explicit null.
func Null[T any]() Opt[T] { return Opt[T]{Set: true} }

// IsZero lets `omitzero` drop absent fields when a patch is re-serialized.
func (o Opt[T]) IsZero() bool { return !o.Set }

func (o *Opt[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		o.Valid = false
		var zero T
		o.Value = zero
		return nil
	}
	if err := json.Unmarshal(data, &o.Value); err != nil {
		return err
	}
	o.Valid = true
	return nil
}

func (o Opt[T]) MarshalJSON() ([]byte, error) {
	if !o.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(o.Value)
}

// SessionLoggingPolicy mirrors SessionLoggingPolicy: the effective retention
// and privacy policy for one host ("*" holds the inherited defaults).
type SessionLoggingPolicy struct {
	ProfileKey string `json:"profileKey"`
	Enabled    bool   `json:"enabled"`
	// CaptureInput is disabled by default because commands can contain
	// passwords, tokens, and other values that should not be retained.
	CaptureInput bool `json:"captureInput"`
	MaxPartBytes int  `json:"maxPartBytes"`
	MaxParts     int  `json:"maxParts"`
	// Overridden is true when an exact per-host override exists instead of
	// inherited defaults.
	Overridden bool `json:"overridden"`
}

// SessionLoggingPolicyInput mirrors SessionLoggingPolicyInput.
type SessionLoggingPolicyInput struct {
	Enabled      bool `json:"enabled"`
	CaptureInput bool `json:"captureInput"`
	MaxPartBytes int  `json:"maxPartBytes"`
	MaxParts     int  `json:"maxParts"`
}

// SessionHistorySettings mirrors SessionHistorySettings: global history
// limits. The per-host policy still owns segment size/count.
type SessionHistorySettings struct {
	// StorageLocation is empty when Muxus uses its platform default.
	StorageLocation string  `json:"storageLocation,omitempty"`
	MaxTotalBytes   int64   `json:"maxTotalBytes"`
	MinFreeBytes    int64   `json:"minFreeBytes"`
	MinFreePercent  float64 `json:"minFreePercent"`
	// MaxAgeDays nil disables age-based eviction.
	MaxAgeDays *int `json:"maxAgeDays,omitempty"`
}

// SessionHistorySettingsInput mirrors SessionHistorySettingsInput.
type SessionHistorySettingsInput struct {
	StorageLocation string  `json:"storageLocation,omitempty"`
	MaxTotalBytes   int64   `json:"maxTotalBytes"`
	MinFreeBytes    int64   `json:"minFreeBytes"`
	MinFreePercent  float64 `json:"minFreePercent"`
	MaxAgeDays      *int    `json:"maxAgeDays,omitempty"`
}

// KeywordHighlightRule mirrors KeywordHighlightRule.
type KeywordHighlightRule struct {
	ID            string `json:"id"`
	Keyword       string `json:"keyword"`
	Foreground    string `json:"foreground"`
	Background    string `json:"background,omitempty"`
	CaseSensitive bool   `json:"caseSensitive"`
	WholeWord     bool   `json:"wholeWord"`
}

// HostKeywordHighlightConfig mirrors HostKeywordHighlightConfig. Host rules
// are additive by default, but can replace the global rule set.
type HostKeywordHighlightConfig struct {
	InheritGlobal bool                   `json:"inheritGlobal"`
	Rules         []KeywordHighlightRule `json:"rules"`
}

// OpenSSHProfileMetadata mirrors OpenSshProfileMetadata: Muxus-only sidebar
// metadata for an OpenSSH alias. Connection details still resolve live from
// the OpenSSH config.
type OpenSSHProfileMetadata struct {
	// ProfileID is a stable local ID that survives an OpenSSH alias rename.
	ProfileID         string                      `json:"profileId"`
	SortOrder         *int                        `json:"sortOrder,omitempty"`
	DisplayName       string                      `json:"displayName,omitempty"`
	Group             string                      `json:"group,omitempty"`
	Color             string                      `json:"color,omitempty"`
	Icon              string                      `json:"icon,omitempty"`
	KeywordHighlights *HostKeywordHighlightConfig `json:"keywordHighlights,omitempty"`
	LastConnectedAt   string                      `json:"lastConnectedAt,omitempty"`
	ConnectCount      int                         `json:"connectCount"`
}

// OpenSSHMetadataPatch mirrors OpenSshMetadataPatch. Every field is
// tri-state: absent keeps the stored value, null clears it.
type OpenSSHMetadataPatch struct {
	DisplayName       Opt[string]                     `json:"displayName,omitzero"`
	Group             Opt[string]                     `json:"group,omitzero"`
	Color             Opt[string]                     `json:"color,omitzero"`
	Icon              Opt[string]                     `json:"icon,omitzero"`
	KeywordHighlights Opt[HostKeywordHighlightConfig] `json:"keywordHighlights,omitzero"`
}

// ManagedHostRef mirrors the ManagedHostRef union: Kind "ssh" carries Alias,
// Kind "profile" carries ID.
type ManagedHostRef struct {
	Kind  string `json:"kind"`
	Alias string `json:"alias,omitempty"`
	ID    string `json:"id,omitempty"`
}

// SavedHostSessionProfile keeps the TelnetProfile | SerialProfile union
// schemaless: the database persists the config keys verbatim, and a typed
// struct would silently drop fields a newer client stored.
type SavedHostSessionProfile map[string]any

// SavedHostProfile mirrors SavedHostProfile: a Telnet/serial host stored
// natively by Muxus rather than in ssh_config.
type SavedHostProfile struct {
	ID        string                  `json:"id"`
	Kind      string                  `json:"kind"`
	Name      string                  `json:"name"`
	Profile   SavedHostSessionProfile `json:"profile"`
	Metadata  OpenSSHProfileMetadata  `json:"metadata"`
	CreatedAt string                  `json:"createdAt"`
	UpdatedAt string                  `json:"updatedAt"`
}

// SavedHostProfileInput mirrors SavedHostProfileInput (id present = update).
type SavedHostProfileInput struct {
	ID      string                  `json:"id,omitempty"`
	Name    string                  `json:"name"`
	Profile SavedHostSessionProfile `json:"profile"`
}

// WorkspaceMultiExecGroup mirrors WorkspaceMultiExecGroup: a reusable
// mirrored-input target set owned by one workspace.
type WorkspaceMultiExecGroup struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	TabIDs []string `json:"tabIds"`
}

// WorkspaceRecord mirrors WorkspaceRecord. Layout is schemaless in the
// database, so it stays `any` here.
type WorkspaceRecord struct {
	ID              string                    `json:"id"`
	Name            string                    `json:"name"`
	Layout          any                       `json:"layout"`
	MultiExecGroups []WorkspaceMultiExecGroup `json:"multiExecGroups"`
	// IsStartup: at most one workspace is selected for startup.
	IsStartup    bool   `json:"isStartup"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	LastOpenedAt string `json:"lastOpenedAt,omitempty"`
}

// WorkspaceSummary mirrors WorkspaceSummary (WorkspaceRecord without the
// layout payloads).
type WorkspaceSummary struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	IsStartup    bool   `json:"isStartup"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	LastOpenedAt string `json:"lastOpenedAt,omitempty"`
}

// TerminalSnapshotRecord mirrors TerminalSnapshotRecord: persisted
// scrollback for one workspace terminal tab.
type TerminalSnapshotRecord struct {
	TabID     string `json:"tabId"`
	Data      string `json:"data"`
	UpdatedAt string `json:"updatedAt"`
}

// ForwardType mirrors ForwardType.
type ForwardType string

const (
	ForwardLocal   ForwardType = "local"
	ForwardRemote  ForwardType = "remote"
	ForwardDynamic ForwardType = "dynamic"
)

// TunnelSSHOptions mirrors TunnelSshOptions: safe-to-persist SSH settings
// owned by a saved tunnel. Pointer fields keep "absent" distinct from an
// explicit false/zero so stored JSON round-trips unchanged.
type TunnelSSHOptions struct {
	User           string   `json:"user,omitempty"`
	Port           *int     `json:"port,omitempty"`
	IdentityFiles  []string `json:"identityFiles,omitempty"`
	IdentitiesOnly *bool    `json:"identitiesOnly,omitempty"`
	ForwardAgent   *bool    `json:"forwardAgent,omitempty"`
	// ProxyJump holds ordered specs: config aliases or "[user@]host[:port]".
	ProxyJump    []string `json:"proxyJump,omitempty"`
	PasswordOnly *bool    `json:"passwordOnly,omitempty"`
}

// TunnelRecord mirrors TunnelRecord: a saved forwarding rule bound to an SSH
// target, started and stopped independently of any terminal.
type TunnelRecord struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Target string `json:"target"`
	// SSHOptions nil means "resolve this target from OpenSSH config". An
	// empty object is meaningful: ad-hoc connection with default agent/key
	// discovery, not inheriting an alias's settings.
	SSHOptions *TunnelSSHOptions `json:"sshOptions,omitempty"`
	Type       ForwardType       `json:"type"`
	BindPort   int               `json:"bindPort"`
	TargetHost string            `json:"targetHost,omitempty"`
	TargetPort *int              `json:"targetPort,omitempty"`
	CreatedAt  string            `json:"createdAt"`
	UpdatedAt  string            `json:"updatedAt"`
}

// TunnelInput mirrors TunnelInput (id present = update).
type TunnelInput struct {
	ID         string            `json:"id,omitempty"`
	Name       string            `json:"name,omitempty"`
	Target     string            `json:"target"`
	SSHOptions *TunnelSSHOptions `json:"sshOptions,omitempty"`
	Type       ForwardType       `json:"type"`
	BindPort   int               `json:"bindPort"`
	TargetHost string            `json:"targetHost,omitempty"`
	TargetPort int               `json:"targetPort,omitempty"`
}
