package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

// terminalSnapshotMaxChars mirrors TERMINAL_SNAPSHOT_MAX_CHARS.
const terminalSnapshotMaxChars = 512_000

// snapshotBodyLimit mirrors SNAPSHOT_BODY_LIMIT: serialized scrollback rides
// in a JSON string, where every ESC byte inflates to six characters, so the
// body can be several times the raw snapshot cap.
const snapshotBodyLimit = 4 * 1024 * 1024

type terminalSnapshotEnvelope struct {
	Snapshot *api.TerminalSnapshotRecord `json:"snapshot"`
}

type snapshotSavedResponse struct {
	Saved bool `json:"saved"`
}

// RegisterTerminalSnapshotRoutes mirrors registerTerminalSnapshotRoutes.
func RegisterTerminalSnapshotRoutes(r chi.Router, db *persist.DB) {
	r.Get("/api/terminal-snapshots/{tabId}", func(w http.ResponseWriter, req *http.Request) {
		record, err := db.TerminalSnapshot(chi.URLParam(req, "tabId"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, terminalSnapshotEnvelope{Snapshot: record})
	})

	r.Put("/api/terminal-snapshots/{tabId}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, snapshotBodyLimit)
		if !ok {
			return
		}
		var probe struct {
			Data *string `json:"data"`
		}
		if err := json.Unmarshal(body, &probe); err != nil || probe.Data == nil ||
			len(*probe.Data) < 1 || len(*probe.Data) > terminalSnapshotMaxChars {
			writeBadRequest(w, "invalid terminal snapshot")
			return
		}
		if err := db.SaveTerminalSnapshot(chi.URLParam(req, "tabId"), *probe.Data); err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, snapshotSavedResponse{Saved: true})
	})
}
