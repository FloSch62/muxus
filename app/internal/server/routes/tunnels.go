package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

func validateTunnel(input api.TunnelInput) string {
	if strings.TrimSpace(input.Target) == "" || len(input.Target) > 500 {
		return "target is required"
	}
	if input.BindPort < 1 || input.BindPort > 65535 {
		return "bindPort must be between 1 and 65535"
	}
	if input.Type != api.ForwardLocal &&
		input.Type != api.ForwardRemote &&
		input.Type != api.ForwardDynamic {
		return "invalid tunnel"
	}
	if input.Type != api.ForwardDynamic &&
		(strings.TrimSpace(input.TargetHost) == "" ||
			input.TargetPort < 1 || input.TargetPort > 65535) {
		return "targetHost and targetPort are required for local/remote tunnels"
	}
	if input.SSHOptions != nil {
		if input.SSHOptions.Port != nil &&
			(*input.SSHOptions.Port < 1 || *input.SSHOptions.Port > 65535) {
			return "port must be between 1 and 65535"
		}
		if len(input.SSHOptions.IdentityFiles) > 32 || len(input.SSHOptions.ProxyJump) > 8 {
			return "invalid tunnel"
		}
	}
	return ""
}

func RegisterTunnelRoutes(r chi.Router, db *persist.DB) {
	r.Get("/api/tunnels", func(w http.ResponseWriter, _ *http.Request) {
		tunnels, err := db.ListTunnels()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, map[string]any{"tunnels": tunnels})
	})
	r.Put("/api/tunnels", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input api.TunnelInput
		if err := json.Unmarshal(body, &input); err != nil {
			writeBadRequest(w, "invalid tunnel")
			return
		}
		if problem := validateTunnel(input); problem != "" {
			writeBadRequest(w, problem)
			return
		}
		record, err := db.SaveTunnel(input)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})
	r.Delete("/api/tunnels/{id}", func(w http.ResponseWriter, req *http.Request) {
		deleted, err := db.DeleteTunnel(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, deletedResponse{Deleted: deleted})
	})
}
