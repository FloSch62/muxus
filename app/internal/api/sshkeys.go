package api

// SshKeyInfo mirrors SshKeyInfo: a private key discovered in ~/.ssh.
type SshKeyInfo struct {
	Path string `json:"path"`
	// Name is the file name ("id_ed25519").
	Name string `json:"name"`
	// Type is the public key algorithm when known ("ssh-ed25519").
	Type string `json:"type,omitempty"`
	// Comment from the sibling .pub file.
	Comment   string `json:"comment,omitempty"`
	Encrypted bool   `json:"encrypted"`
	// InAgent reports whether the key is currently loaded in the SSH agent.
	InAgent bool `json:"inAgent"`
}

// SshAgentKey mirrors SshAgentKey.
type SshAgentKey struct {
	Type    string `json:"type"`
	Comment string `json:"comment,omitempty"`
	// Fingerprint is the SHA256:… fingerprint, OpenSSH presentation.
	Fingerprint string `json:"fingerprint"`
}

// SshKeysResponse mirrors SshKeysResponse.
type SshKeysResponse struct {
	AgentAvailable bool          `json:"agentAvailable"`
	AgentKeys      []SshAgentKey `json:"agentKeys"`
	Keys           []SshKeyInfo  `json:"keys"`
}
