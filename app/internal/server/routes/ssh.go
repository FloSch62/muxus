package routes

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/sshx"
)

func writeConfigError(w http.ResponseWriter, err error) {
	if problem, ok := err.(*sshx.ConfigProblem); ok {
		server.WriteJSON(w, problem.Status, api.ErrorBody{
			Message: problem.Message,
			Code:    problem.Code,
		})
		return
	}
	writeInternalError(w, err)
}

func RegisterSSHRoutes(r chi.Router, db *persist.DB) {
	r.Get("/api/ssh/config", func(w http.ResponseWriter, _ *http.Request) {
		path := sshx.DefaultConfigPath()
		doc := sshx.LoadConfigDocument(path)
		hosts := sshx.ListHosts(doc)
		sort.SliceStable(hosts, func(i, j int) bool { return hosts[i].Alias < hosts[j].Alias })
		aliases := make([]string, len(hosts))
		for index := range hosts {
			aliases[index] = hosts[index].Alias
		}
		metadata, err := db.OpenSSHMetadata(aliases)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		for index := range hosts {
			if value, ok := metadata[hosts[index].Alias]; ok {
				value := value
				hosts[index].Metadata = &value
			}
		}
		server.WriteJSON(w, http.StatusOK, api.SSHConfigResponse{
			Path: path, Files: doc.FileOrder, Hosts: hosts, Error: doc.Error,
		})
	})

	parseUpsert := func(w http.ResponseWriter, req *http.Request) (api.HostUpsertRequest, bool) {
		var input api.HostUpsertRequest
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return input, false
		}
		if err := json.Unmarshal(body, &input); err != nil {
			writeBadRequest(w, "invalid host payload")
			return input, false
		}
		return input, true
	}

	r.Post("/api/ssh/config/hosts", func(w http.ResponseWriter, req *http.Request) {
		input, ok := parseUpsert(w, req)
		if !ok {
			return
		}
		result, err := sshx.UpsertHost(input, sshx.DefaultConfigPath())
		if err != nil {
			writeConfigError(w, err)
			return
		}
		if input.PreviousAlias != "" {
			if err := db.RenameOpenSSHAlias(input.PreviousAlias, input.Aliases[0]); err != nil {
				writeInternalError(w, err)
				return
			}
		}
		server.WriteJSON(w, http.StatusOK, result)
	})

	r.Post("/api/ssh/config/preview", func(w http.ResponseWriter, req *http.Request) {
		input, ok := parseUpsert(w, req)
		if !ok {
			return
		}
		text, err := sshx.PreviewHost(input, sshx.DefaultConfigPath())
		if err != nil {
			writeConfigError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, api.HostPreviewResponse{Text: text})
	})

	r.Delete("/api/ssh/config/hosts/{alias}", func(w http.ResponseWriter, req *http.Request) {
		alias := chi.URLParam(req, "alias")
		if err := sshx.DeleteHost(alias, sshx.DefaultConfigPath()); err != nil {
			writeConfigError(w, err)
			return
		}
		if _, err := db.DeleteSessionLoggingPolicy("ssh:" + alias); err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	r.Patch("/api/ssh/config/hosts/{alias}/metadata", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		patch, err := parseMetadataPatch(body)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		record, err := db.UpdateOpenSSHMetadata(chi.URLParam(req, "alias"), patch)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Get("/api/ssh/keys", func(w http.ResponseWriter, _ *http.Request) {
		server.WriteJSON(w, http.StatusOK, sshx.ListSshKeys(""))
	})
}
