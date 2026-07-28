package api

// Session-history DTOs from shared/src/api-types.ts. SessionLoggingPolicy,
// SessionHistorySettings, and their inputs already live in persistence.go.

// SessionLogSummary mirrors SessionLogSummary: durable session metadata
// returned by history list/search.
type SessionLogSummary struct {
	ID              string `json:"id"`
	ProfileKey      string `json:"profileKey"`
	Title           string `json:"title"`
	Kind            string `json:"kind"`
	Host            string `json:"host"`
	StartedAt       string `json:"startedAt"`
	EndedAt         string `json:"endedAt,omitempty"`
	Status          string `json:"status"`
	Paused          bool   `json:"paused"`
	CaptureInput    bool   `json:"captureInput"`
	EventCount      int64  `json:"eventCount"`
	RawBytes        int64  `json:"rawBytes"`
	NormalizedBytes int64  `json:"normalizedBytes"`
	PartCount       int64  `json:"partCount"`
	// Pinned sessions are excluded from age and quota eviction.
	Pinned bool `json:"pinned"`
	// Snippet is a search-context excerpt, present only for matching
	// full-text queries.
	Snippet string `json:"snippet,omitempty"`
}

// SessionLogEvent mirrors SessionLogEvent: one timestamped, normalized replay
// event. Raw bytes remain server-side.
type SessionLogEvent struct {
	Sequence   int64  `json:"sequence"`
	RecordedAt string `json:"recordedAt"`
	ElapsedMs  int64  `json:"elapsedMs"`
	Direction  string `json:"direction"`
	Text       string `json:"text"`
}

// SessionLogDetail mirrors SessionLogDetail.
type SessionLogDetail struct {
	SessionLogSummary
	Events []SessionLogEvent `json:"events"`
	// EventsTruncated is true when the API returned only the newest preview
	// events.
	EventsTruncated bool `json:"eventsTruncated"`
}

// SessionHistoryResponse mirrors SessionHistoryResponse.
type SessionHistoryResponse struct {
	Sessions []SessionLogSummary `json:"sessions"`
	// NextCursor is an opaque key for the next page. Exact result counts are
	// intentionally omitted.
	NextCursor string `json:"nextCursor,omitempty"`
}

// SessionHistoryStorageStatus mirrors SessionHistoryStorageStatus.
type SessionHistoryStorageStatus struct {
	Settings              SessionHistorySettings `json:"settings"`
	ActiveStorageLocation string                 `json:"activeStorageLocation"`
	UsageBytes            int64                  `json:"usageBytes"`
	FreeBytes             int64                  `json:"freeBytes"`
	QuotaSuspended        bool                   `json:"quotaSuspended"`
	Warning               string                 `json:"warning,omitempty"`
	// RestartRequired: a changed storage path is picked up on the next launch.
	RestartRequired bool `json:"restartRequired"`
}
