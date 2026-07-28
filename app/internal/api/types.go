// Package api mirrors shared/src/api-types.ts. Field names and JSON tags must
// match the TypeScript DTOs exactly; the contract fixture suite in
// tests/contract enforces this from both sides.
package api

// ErrorBody is ApiErrorBody: the shape of every REST error response.
type ErrorBody struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// AppInfo mirrors AppInfo.
type AppInfo struct {
	Name string `json:"name"`
	// Platform uses Node's process.platform names ('linux', 'win32', 'darwin')
	// because the client switches on them.
	Platform     string `json:"platform"`
	Version      string `json:"version"`
	HomeDir      string `json:"homeDir"`
	DefaultShell string `json:"defaultShell"`
}

// UpdateCheckResult mirrors the UpdateCheckResult discriminated union. With
// Available=true the release fields are set; otherwise only CurrentVersion is
// guaranteed, with LatestVersion/Reason optional.
type UpdateCheckResult struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReleaseName    string `json:"releaseName,omitempty"`
	ReleaseURL     string `json:"releaseUrl,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
	Reason         string `json:"reason,omitempty"`
}
