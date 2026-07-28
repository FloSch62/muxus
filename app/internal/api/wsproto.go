package api

// Mirror of shared/src/ws-protocol.ts: the /ws/terminal wire contract.
// Validation replicates the zod schemas — same limits, same defaults, same
// trim-then-validate order — so both implementations accept and reject the
// same payloads. The contract fixture suite exercises this from both sides.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// LocalProfile: where a local terminal runs. Secrets are never part of any
// profile — they travel only in auth-response replies.
type LocalProfile struct {
	Kind  string `json:"kind"`
	Shell string `json:"shell,omitempty"`
	Cwd   string `json:"cwd,omitempty"`
}

type SSHProfile struct {
	Kind string `json:"kind"`
	// Target is a ~/.ssh/config alias or an ad-hoc "[user@]host[:port]";
	// everything else resolves server-side exactly like `ssh <target>`.
	Target         string   `json:"target"`
	UseConfig      *bool    `json:"useConfig,omitempty"`
	User           string   `json:"user,omitempty"`
	Port           int      `json:"port,omitempty"`
	IdentityFiles  []string `json:"identityFiles,omitempty"`
	IdentitiesOnly *bool    `json:"identitiesOnly,omitempty"`
	ForwardAgent   *bool    `json:"forwardAgent,omitempty"`
	ProxyJump      []string `json:"proxyJump,omitempty"`
	PasswordOnly   *bool    `json:"passwordOnly,omitempty"`
}

type TelnetProfile struct {
	Kind      string `json:"kind"`
	ProfileID string `json:"profileId,omitempty"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
}

type SerialProfile struct {
	Kind      string `json:"kind"`
	ProfileID string `json:"profileId,omitempty"`
	// Path is the OS-native device path: COM3, /dev/ttyUSB0, …
	Path        string  `json:"path"`
	BaudRate    int     `json:"baudRate"`
	DataBits    int     `json:"dataBits"`
	StopBits    float64 `json:"stopBits"`
	Parity      string  `json:"parity"`
	FlowControl string  `json:"flowControl"`
}

// SessionProfile is the discriminated union over the four profile kinds;
// exactly one field is non-nil after a successful Parse.
type SessionProfile struct {
	Local  *LocalProfile
	SSH    *SSHProfile
	Telnet *TelnetProfile
	Serial *SerialProfile
}

func (p SessionProfile) Kind() string {
	switch {
	case p.Local != nil:
		return "local"
	case p.SSH != nil:
		return "ssh"
	case p.Telnet != nil:
		return "telnet"
	case p.Serial != nil:
		return "serial"
	}
	return ""
}

func (p SessionProfile) MarshalJSON() ([]byte, error) {
	switch {
	case p.Local != nil:
		return json.Marshal(p.Local)
	case p.SSH != nil:
		return json.Marshal(p.SSH)
	case p.Telnet != nil:
		return json.Marshal(p.Telnet)
	case p.Serial != nil:
		return json.Marshal(p.Serial)
	}
	return nil, errors.New("empty session profile")
}

func (p *SessionProfile) UnmarshalJSON(data []byte) error {
	parsed, err := ParseSessionProfile(data)
	if err != nil {
		return err
	}
	*p = parsed
	return nil
}

func stringLen(field, value string, min, max int) error {
	if len(value) < min || len(value) > max {
		return fmt.Errorf("%s: length must be %d-%d", field, min, max)
	}
	return nil
}

func intRange(field string, value, min, max int) error {
	if value < min || value > max {
		return fmt.Errorf("%s: must be %d-%d", field, min, max)
	}
	return nil
}

func parseSSHProfile(data []byte) (*SSHProfile, error) {
	var p SSHProfile
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	if p.Target == "" {
		return nil, errors.New("target: required")
	}
	if p.Port != 0 {
		if err := intRange("port", p.Port, 1, 65535); err != nil {
			return nil, err
		}
	}
	if len(p.IdentityFiles) > 32 {
		return nil, errors.New("identityFiles: at most 32 entries")
	}
	for _, f := range p.IdentityFiles {
		if err := stringLen("identityFiles[]", f, 1, 4096); err != nil {
			return nil, err
		}
	}
	if len(p.ProxyJump) > 8 {
		return nil, errors.New("proxyJump: at most 8 hops")
	}
	for _, hop := range p.ProxyJump {
		if err := stringLen("proxyJump[]", hop, 1, 500); err != nil {
			return nil, err
		}
	}
	return &p, nil
}

// ParseSessionProfile validates a profile the way sessionProfileSchema does,
// applying the same defaults.
func ParseSessionProfile(data []byte) (SessionProfile, error) {
	var kindProbe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &kindProbe); err != nil {
		return SessionProfile{}, err
	}
	switch kindProbe.Kind {
	case "local":
		var p LocalProfile
		if err := json.Unmarshal(data, &p); err != nil {
			return SessionProfile{}, err
		}
		return SessionProfile{Local: &p}, nil
	case "ssh":
		p, err := parseSSHProfile(data)
		if err != nil {
			return SessionProfile{}, err
		}
		return SessionProfile{SSH: p}, nil
	case "telnet":
		var p TelnetProfile
		p.Port = 23
		if err := json.Unmarshal(data, &p); err != nil {
			return SessionProfile{}, err
		}
		p.Host = strings.TrimSpace(p.Host)
		if err := stringLen("host", p.Host, 1, 253); err != nil {
			return SessionProfile{}, err
		}
		if err := intRange("port", p.Port, 1, 65535); err != nil {
			return SessionProfile{}, err
		}
		if p.ProfileID != "" {
			if err := stringLen("profileId", p.ProfileID, 1, 200); err != nil {
				return SessionProfile{}, err
			}
		}
		return SessionProfile{Telnet: &p}, nil
	case "serial":
		p := SerialProfile{BaudRate: 115_200, DataBits: 8, StopBits: 1, Parity: "none", FlowControl: "none"}
		if err := json.Unmarshal(data, &p); err != nil {
			return SessionProfile{}, err
		}
		p.Path = strings.TrimSpace(p.Path)
		if err := stringLen("path", p.Path, 1, 4096); err != nil {
			return SessionProfile{}, err
		}
		if err := intRange("baudRate", p.BaudRate, 1, 12_000_000); err != nil {
			return SessionProfile{}, err
		}
		switch p.DataBits {
		case 5, 6, 7, 8:
		default:
			return SessionProfile{}, errors.New("dataBits: must be 5, 6, 7, or 8")
		}
		switch p.StopBits {
		case 1, 1.5, 2:
		default:
			return SessionProfile{}, errors.New("stopBits: must be 1, 1.5, or 2")
		}
		switch p.Parity {
		case "none", "even", "odd", "mark", "space":
		default:
			return SessionProfile{}, errors.New("parity: invalid value")
		}
		switch p.FlowControl {
		case "none", "hardware", "software":
		default:
			return SessionProfile{}, errors.New("flowControl: invalid value")
		}
		if p.ProfileID != "" {
			if err := stringLen("profileId", p.ProfileID, 1, 200); err != nil {
				return SessionProfile{}, err
			}
		}
		return SessionProfile{Serial: &p}, nil
	default:
		return SessionProfile{}, fmt.Errorf("profile kind %q not recognized", kindProbe.Kind)
	}
}

// TerminalClientMessage is the union of text frames the client sends;
// exactly one op field is non-nil after ParseTerminalClientMessage.
type TerminalClientMessage struct {
	Connect         *ConnectMessage
	Dial            *DialMessage
	Resize          *ResizeMessage
	AuthResponse    *AuthResponseMessage
	HostKeyResponse *HostKeyResponseMessage
	SetLogging      *SetLoggingMessage
}

type ConnectMessage struct {
	Profile SessionProfile
	// Title is the user-facing tab title retained in session history.
	Title string
	Cols  int
	Rows  int
}

type DialMessage struct {
	Profile *SSHProfile
}

type ResizeMessage struct {
	Cols int
	Rows int
}

type AuthResponseMessage struct {
	// Answers reply to the last auth-prompt, in prompt order.
	Answers []string
}

type HostKeyResponseMessage struct {
	Accept bool
}

// SetLoggingMessage changes only the current session; persisted policy is
// managed over REST. At least one field is set.
type SetLoggingMessage struct {
	Enabled      *bool
	Paused       *bool
	CaptureInput *bool
}

func ParseTerminalClientMessage(data []byte) (TerminalClientMessage, error) {
	var envelope struct {
		Op           string          `json:"op"`
		Profile      json.RawMessage `json:"profile"`
		Title        *string         `json:"title"`
		Cols         *int            `json:"cols"`
		Rows         *int            `json:"rows"`
		Answers      *[]string       `json:"answers"`
		Accept       *bool           `json:"accept"`
		Enabled      *bool           `json:"enabled"`
		Paused       *bool           `json:"paused"`
		CaptureInput *bool           `json:"captureInput"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return TerminalClientMessage{}, err
	}
	switch envelope.Op {
	case "connect":
		if envelope.Profile == nil {
			return TerminalClientMessage{}, errors.New("connect: profile required")
		}
		profile, err := ParseSessionProfile(envelope.Profile)
		if err != nil {
			return TerminalClientMessage{}, err
		}
		msg := ConnectMessage{Profile: profile}
		if envelope.Title != nil {
			msg.Title = strings.TrimSpace(*envelope.Title)
			if err := stringLen("title", msg.Title, 1, 500); err != nil {
				return TerminalClientMessage{}, err
			}
		}
		if envelope.Cols == nil || *envelope.Cols < 1 || envelope.Rows == nil || *envelope.Rows < 1 {
			return TerminalClientMessage{}, errors.New("connect: positive cols and rows required")
		}
		msg.Cols, msg.Rows = *envelope.Cols, *envelope.Rows
		return TerminalClientMessage{Connect: &msg}, nil
	case "dial":
		if envelope.Profile == nil {
			return TerminalClientMessage{}, errors.New("dial: profile required")
		}
		profile, err := parseSSHProfile(envelope.Profile)
		if err != nil {
			return TerminalClientMessage{}, err
		}
		if profile.Kind != "ssh" {
			return TerminalClientMessage{}, errors.New("dial: ssh profile required")
		}
		return TerminalClientMessage{Dial: &DialMessage{Profile: profile}}, nil
	case "resize":
		if envelope.Cols == nil || *envelope.Cols < 1 || envelope.Rows == nil || *envelope.Rows < 1 {
			return TerminalClientMessage{}, errors.New("resize: positive cols and rows required")
		}
		return TerminalClientMessage{Resize: &ResizeMessage{Cols: *envelope.Cols, Rows: *envelope.Rows}}, nil
	case "auth-response":
		if envelope.Answers == nil {
			return TerminalClientMessage{}, errors.New("auth-response: answers required")
		}
		return TerminalClientMessage{AuthResponse: &AuthResponseMessage{Answers: *envelope.Answers}}, nil
	case "host-key-response":
		if envelope.Accept == nil {
			return TerminalClientMessage{}, errors.New("host-key-response: accept required")
		}
		return TerminalClientMessage{HostKeyResponse: &HostKeyResponseMessage{Accept: *envelope.Accept}}, nil
	case "set-logging":
		if envelope.Enabled == nil && envelope.Paused == nil && envelope.CaptureInput == nil {
			return TerminalClientMessage{}, errors.New("set-logging: at least one field required")
		}
		return TerminalClientMessage{SetLogging: &SetLoggingMessage{
			Enabled:      envelope.Enabled,
			Paused:       envelope.Paused,
			CaptureInput: envelope.CaptureInput,
		}}, nil
	default:
		return TerminalClientMessage{}, fmt.Errorf("op %q not recognized", envelope.Op)
	}
}

// Server → client text frames. Each struct marshals to the exact JSON the
// TypeScript TerminalServerMessage union describes.

type StatusMessage struct {
	Op string `json:"op"`
	// Message is connection progress worth echoing into the terminal.
	Message   string `json:"message"`
	Transient bool   `json:"transient,omitempty"`
}

func NewStatus(message string, transient bool) StatusMessage {
	return StatusMessage{Op: "status", Message: message, Transient: transient}
}

type ConnectionHealthMessage struct {
	Op string `json:"op"`
	// State is passive SSH transport health from the keepalive lifecycle.
	State string `json:"state"`
}

func NewConnectionHealth(state string) ConnectionHealthMessage {
	return ConnectionHealthMessage{Op: "connection-health", State: state}
}

type AuthPromptEntry struct {
	Prompt string `json:"prompt"`
	Echo   bool   `json:"echo"`
}

type AuthPromptMessage struct {
	Op           string `json:"op"`
	Name         string `json:"name,omitempty"`
	Instructions string `json:"instructions,omitempty"`
	// Host names which hop in the connection chain is asking.
	Host    string            `json:"host,omitempty"`
	Prompts []AuthPromptEntry `json:"prompts"`
}

func NewAuthPrompt(prompts []AuthPromptEntry) AuthPromptMessage {
	return AuthPromptMessage{Op: "auth-prompt", Prompts: prompts}
}

type HostKeyMessage struct {
	Op      string `json:"op"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	KeyType string `json:"keyType"`
	// Fingerprint is SHA256:…, OpenSSH presentation.
	Fingerprint string `json:"fingerprint"`
	// State: new = first contact (TOFU), mismatch = KEY CHANGED.
	State    string `json:"state"`
	Previous string `json:"previous,omitempty"`
	// Hop is set for an intermediate ProxyJump hop, not the final target.
	Hop string `json:"hop,omitempty"`
}

type ReadyMessage struct {
	Op string `json:"op"`
	// ConnID keys follow-up SFTP/forward calls for SSH sessions.
	ConnID string `json:"connId"`
	Host   string `json:"host,omitempty"`
	User   string `json:"user,omitempty"`
}

func NewReady(connID string) ReadyMessage {
	return ReadyMessage{Op: "ready", ConnID: connID}
}

type LoggingStateMessage struct {
	Op           string `json:"op"`
	Enabled      bool   `json:"enabled"`
	SessionID    string `json:"sessionId,omitempty"`
	Paused       bool   `json:"paused"`
	CaptureInput bool   `json:"captureInput"`
	// Warning is present when storage/backpressure suspended logging.
	Warning string `json:"warning,omitempty"`
}

type ExitMessage struct {
	Op      string `json:"op"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	// Reason: completed | failed | disconnected.
	Reason string `json:"reason"`
}
