package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/forwards"
	"github.com/FloSch62/muxus/app/internal/server"
)

func writeForwardError(w http.ResponseWriter, err error) {
	if problem, ok := err.(*forwards.HTTPError); ok {
		server.WriteJSON(w, problem.Status, api.ErrorBody{Message: problem.Message})
		return
	}
	writeInternalError(w, err)
}

func validForwardRequest(request api.ForwardRequest) bool {
	if request.ConnID == "" || request.BindPort < 1 || request.BindPort > 65535 {
		return false
	}
	if request.Type != "local" && request.Type != "remote" && request.Type != "dynamic" {
		return false
	}
	if request.Type != "dynamic" {
		return request.TargetHost != "" && request.TargetPort >= 1 && request.TargetPort <= 65535
	}
	return true
}

func RegisterForwardRoutes(r chi.Router, ctx *server.Context) {
	r.Get("/api/forwards", func(w http.ResponseWriter, req *http.Request) {
		server.WriteJSON(w, http.StatusOK, map[string]any{
			"forwards": ctx.Forwards.List(req.URL.Query().Get("connId")),
		})
	})
	r.Post("/api/forwards", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input api.ForwardRequest
		if err := json.Unmarshal(body, &input); err != nil || !validForwardRequest(input) {
			writeBadRequest(w, "invalid forward request")
			return
		}
		info, err := ctx.Forwards.Start(input, "manual")
		if err != nil {
			writeForwardError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, info)
	})
	r.Delete("/api/forwards/{id}", func(w http.ResponseWriter, req *http.Request) {
		ctx.Forwards.Stop(chi.URLParam(req, "id"))
		server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	r.Patch("/api/forwards/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input struct {
			TunnelID string `json:"tunnelId"`
		}
		if json.Unmarshal(body, &input) != nil || input.TunnelID == "" {
			writeBadRequest(w, "tunnelId is required")
			return
		}
		info := ctx.Forwards.AssignTunnel(chi.URLParam(req, "id"), input.TunnelID)
		if info == nil {
			writeNotFound(w, "forward not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, info)
	})
	r.Get("/api/connections", func(w http.ResponseWriter, _ *http.Request) {
		server.WriteJSON(w, http.StatusOK, api.ConnectionsResponse{
			Connections: ctx.Connections.List(),
		})
	})
}
