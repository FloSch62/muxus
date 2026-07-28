package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

type hostOrderResponse struct {
	OK bool `json:"ok"`
}

// parseHostOrder mirrors hostOrderSchema.
func parseHostOrder(body []byte) ([]api.ManagedHostRef, error) {
	var probe struct {
		Hosts *[]struct {
			Kind  string  `json:"kind"`
			Alias *string `json:"alias"`
			ID    *string `json:"id"`
		} `json:"hosts"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, errors.New("invalid host order")
	}
	if probe.Hosts == nil {
		return nil, errors.New("hosts is required")
	}
	if len(*probe.Hosts) > 10_000 {
		return nil, errors.New("hosts must be at most 10000 entries")
	}
	refs := make([]api.ManagedHostRef, 0, len(*probe.Hosts))
	for _, host := range *probe.Hosts {
		switch host.Kind {
		case "ssh":
			if host.Alias == nil || len(*host.Alias) < 1 || len(*host.Alias) > 200 {
				return nil, errors.New("host alias must be 1-200 characters")
			}
			refs = append(refs, api.ManagedHostRef{Kind: "ssh", Alias: *host.Alias})
		case "profile":
			if host.ID == nil || len(*host.ID) < 1 || len(*host.ID) > 200 {
				return nil, errors.New("host id must be 1-200 characters")
			}
			refs = append(refs, api.ManagedHostRef{Kind: "profile", ID: *host.ID})
		default:
			return nil, fmt.Errorf("host kind %q not recognized", host.Kind)
		}
	}
	return refs, nil
}

// RegisterHostOrderRoutes mirrors registerHostOrderRoutes: one visual sidebar
// order spanning OpenSSH hosts and saved Telnet/serial hosts.
func RegisterHostOrderRoutes(r chi.Router, db *persist.DB) {
	r.Put("/api/hosts/order", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		refs, err := parseHostOrder(body)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		seen := make(map[string]bool, len(refs))
		for _, ref := range refs {
			key := "profile:" + ref.ID
			if ref.Kind == "ssh" {
				key = "ssh:" + ref.Alias
			}
			if seen[key] {
				writeBadRequest(w, "host order contains duplicates")
				return
			}
			seen[key] = true
		}
		if err := db.ReorderManagedHosts(refs); err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, hostOrderResponse{OK: true})
	})
}
