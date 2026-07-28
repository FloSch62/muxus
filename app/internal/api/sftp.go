package api

type SftpEntry struct {
	Name           string  `json:"name"`
	Type           string  `json:"type"`
	Size           *int64  `json:"size,omitempty"`
	MtimeMs        *int64  `json:"mtimeMs,omitempty"`
	Mode           *uint32 `json:"mode,omitempty"`
	Owner          string  `json:"owner,omitempty"`
	Group          string  `json:"group,omitempty"`
	DownloadTicket string  `json:"downloadTicket,omitempty"`
}

type SftpListResponse struct {
	Path    string      `json:"path"`
	Entries []SftpEntry `json:"entries"`
}

type SftpFileResponse struct {
	Path    string  `json:"path"`
	Content string  `json:"content"`
	Size    int64   `json:"size"`
	MtimeMs *int64  `json:"mtimeMs,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
}

type SftpFileSaveRequest struct {
	Content         string `json:"content"`
	ExpectedMtimeMs *int64 `json:"expectedMtimeMs,omitempty"`
	Force           bool   `json:"force,omitempty"`
}

type SftpFileSaveResponse struct {
	OK      bool   `json:"ok"`
	Size    int64  `json:"size"`
	MtimeMs *int64 `json:"mtimeMs,omitempty"`
}
