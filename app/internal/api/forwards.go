package api

// Forward and connection DTOs mirroring shared/src/api-types.ts.

type ConfigForward struct {
	Type string `json:"type"`
	// BindPort is the listen port — local port for local/dynamic, remote
	// bind port for remote.
	BindPort   int    `json:"bindPort"`
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`
}

type ForwardRequest struct {
	ConnID     string `json:"connId"`
	Type       string `json:"type"`
	BindPort   int    `json:"bindPort"`
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`
	// TunnelID is the saved tunnel this forward realizes (running-state
	// matching in the UI).
	TunnelID string `json:"tunnelId,omitempty"`
}

type ForwardInfo struct {
	ID         string `json:"id"`
	ConnID     string `json:"connId"`
	Type       string `json:"type"`
	BindPort   int    `json:"bindPort"`
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`
	// Origin: config = auto-started from a *Forward line; manual = runtime.
	Origin string `json:"origin"`
	// Lifecycle: session forwards stop with the terminal that created the
	// connection; independent forwards are saved/manual tunnels.
	Lifecycle string `json:"lifecycle"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	TunnelID  string `json:"tunnelId,omitempty"`
}

type ConnectionInfo struct {
	ID string `json:"id"`
	// Target is what was dialed — config alias or ad-hoc "[user@]host[:port]".
	Target        string `json:"target"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	MetadataAlias string `json:"metadataAlias,omitempty"`
}

type ConnectionsResponse struct {
	Connections []ConnectionInfo `json:"connections"`
}
