package api

// ssh_config DTOs mirroring shared/src/api-types.ts. Pointer fields keep
// "absent" distinct from an explicit zero value because the editor's
// validation and rendering treat them differently; `omitzero` on slices keeps
// an empty list distinct from an absent one (ProxyJump [] means
// "ProxyJump none", absent means "not written in the block").

// ConfigForward is declared in forwards.go.

// HostExtraOption is one unmodeled `Keyword value` pair kept verbatim in
// HostBlockOptions.Extras so editing a block never drops hand-written
// options.
type HostExtraOption struct {
	Keyword string `json:"keyword"`
	Value   string `json:"value"`
}

// HostBlockOptions mirrors HostBlockOptions: options written in one Host
// block — exactly what the editor round-trips.
type HostBlockOptions struct {
	Hostname         *string  `json:"hostname,omitempty"`
	User             *string  `json:"user,omitempty"`
	Port             *int     `json:"port,omitempty"`
	IdentityFiles    []string `json:"identityFiles,omitzero"`
	CertificateFiles []string `json:"certificateFiles,omitzero"`
	IdentitiesOnly   *bool    `json:"identitiesOnly,omitempty"`
	ForwardAgent     *bool    `json:"forwardAgent,omitempty"`
	// ProxyJump holds hops in order ("bastion", "user@host:2222"); a non-nil
	// empty slice is an explicit "ProxyJump none".
	ProxyJump    []string        `json:"proxyJump,omitzero"`
	ProxyCommand *string         `json:"proxyCommand,omitempty"`
	Forwards     []ConfigForward `json:"forwards,omitzero"`
	// PasswordOnly skips public keys and goes straight to
	// password/keyboard-interactive.
	PasswordOnly bool              `json:"passwordOnly,omitempty"`
	Extras       []HostExtraOption `json:"extras,omitzero"`
}

// ResolvedHostSettings mirrors ResolvedHostSettings: effective settings after
// full Host-pattern resolution (what connect uses).
type ResolvedHostSettings struct {
	Hostname         string   `json:"hostname"`
	User             string   `json:"user,omitempty"`
	Port             int      `json:"port"`
	IdentityFiles    []string `json:"identityFiles"`
	CertificateFiles []string `json:"certificateFiles"`
	IdentitiesOnly   bool     `json:"identitiesOnly"`
	ForwardAgent     bool     `json:"forwardAgent"`
	ProxyJump        []string `json:"proxyJump"`
	// ProxyCommand is the raw value after Host-pattern resolution; tokens
	// expand at dial time.
	ProxyCommand string          `json:"proxyCommand,omitempty"`
	Forwards     []ConfigForward `json:"forwards"`
	PasswordOnly bool            `json:"passwordOnly"`
}

// SSHHostEntry mirrors SshHostEntry: one connectable Host entry parsed from
// ~/.ssh/config.
type SSHHostEntry struct {
	// Alias is the primary alias — the block's first concrete Host pattern.
	Alias string `json:"alias"`
	// Aliases lists every concrete alias on the block's Host line.
	Aliases     []string                `json:"aliases"`
	Description string                  `json:"description,omitempty"`
	File        string                  `json:"file"`
	Options     HostBlockOptions        `json:"options"`
	Resolved    ResolvedHostSettings    `json:"resolved"`
	Metadata    *OpenSSHProfileMetadata `json:"metadata,omitempty"`
}

// SSHConfigResponse mirrors SshConfigResponse.
type SSHConfigResponse struct {
	Path  string         `json:"path"`
	Files []string       `json:"files"`
	Hosts []SSHHostEntry `json:"hosts"`
	Error string         `json:"error,omitempty"`
}

// HostUpsertRequest mirrors HostUpsertRequest: create/update a Host block in
// ssh config.
type HostUpsertRequest struct {
	Aliases     []string `json:"aliases"`
	Description string   `json:"description,omitempty"`
	// File nil defaults to the edited block's file or the root config. A
	// present-but-empty string is not a default (it resolves and is rejected
	// downstream), matching the TS `??` semantics.
	File          *string          `json:"file,omitempty"`
	Options       HostBlockOptions `json:"options"`
	PreviousAlias string           `json:"previousAlias,omitempty"`
}

// HostPreviewResponse mirrors HostPreviewResponse: the serialized Host block
// exactly as it would be written to the config.
type HostPreviewResponse struct {
	Text string `json:"text"`
}
