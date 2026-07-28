package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

// hexColorPattern mirrors hexColorSchema in metadata-schema.ts.
var hexColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type savedHostProfilesResponse struct {
	Profiles []api.SavedHostProfile `json:"profiles"`
}

// parseSavedProfile mirrors savedProfileSchema: a saved host is a named
// Telnet or serial session profile.
func parseSavedProfile(body []byte) (api.SavedHostProfileInput, error) {
	var zero api.SavedHostProfileInput
	var probe struct {
		ID      *string         `json:"id"`
		Name    *string         `json:"name"`
		Profile json.RawMessage `json:"profile"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return zero, errors.New("invalid saved host")
	}
	var input api.SavedHostProfileInput
	if probe.ID != nil {
		if len(*probe.ID) < 1 || len(*probe.ID) > 200 {
			return zero, errors.New("saved host id must be 1-200 characters")
		}
		input.ID = *probe.ID
	}
	if probe.Name == nil {
		return zero, errors.New("saved host name is required")
	}
	name := strings.TrimSpace(*probe.Name)
	if name == "" || len(name) > 200 {
		return zero, errors.New("saved host name must be 1-200 characters")
	}
	input.Name = name
	if probe.Profile == nil {
		return zero, errors.New("saved host profile is required")
	}
	var kindProbe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(probe.Profile, &kindProbe); err != nil {
		return zero, errors.New("invalid saved host profile")
	}
	if kindProbe.Kind != "telnet" && kindProbe.Kind != "serial" {
		return zero, fmt.Errorf("saved host kind %q not recognized", kindProbe.Kind)
	}
	profile, err := api.ParseSessionProfile(probe.Profile)
	if err != nil {
		return zero, err
	}
	// Round-trip through the typed profile so defaults are applied and unknown
	// keys are stripped, matching zod's normalized output.
	raw, err := json.Marshal(profile)
	if err != nil {
		return zero, err
	}
	var normalized api.SavedHostSessionProfile
	if err := json.Unmarshal(raw, &normalized); err != nil {
		return zero, err
	}
	input.Profile = normalized
	return input, nil
}

type keywordHighlightRuleBody struct {
	ID            string  `json:"id"`
	Keyword       string  `json:"keyword"`
	Foreground    string  `json:"foreground"`
	Background    *string `json:"background"`
	CaseSensitive *bool   `json:"caseSensitive"`
	WholeWord     *bool   `json:"wholeWord"`
}

type keywordHighlightsBody struct {
	InheritGlobal *bool                       `json:"inheritGlobal"`
	Rules         *[]keywordHighlightRuleBody `json:"rules"`
}

// parseKeywordHighlights mirrors hostKeywordHighlightsSchema.
func parseKeywordHighlights(body keywordHighlightsBody) (api.HostKeywordHighlightConfig, error) {
	var zero api.HostKeywordHighlightConfig
	if body.InheritGlobal == nil {
		return zero, errors.New("keywordHighlights.inheritGlobal is required")
	}
	if body.Rules == nil || len(*body.Rules) > 100 {
		return zero, errors.New("keywordHighlights.rules must be at most 100 rules")
	}
	config := api.HostKeywordHighlightConfig{
		InheritGlobal: *body.InheritGlobal,
		Rules:         make([]api.KeywordHighlightRule, 0, len(*body.Rules)),
	}
	for _, rule := range *body.Rules {
		if len(rule.ID) < 1 || len(rule.ID) > 100 {
			return zero, errors.New("keyword highlight rule id must be 1-100 characters")
		}
		if len(rule.Keyword) < 1 || len(rule.Keyword) > 500 {
			return zero, errors.New("keyword highlight keyword must be 1-500 characters")
		}
		if !hexColorPattern.MatchString(rule.Foreground) {
			return zero, errors.New("keyword highlight foreground must be a #rrggbb color")
		}
		if rule.Background != nil && !hexColorPattern.MatchString(*rule.Background) {
			return zero, errors.New("keyword highlight background must be a #rrggbb color")
		}
		if rule.CaseSensitive == nil || rule.WholeWord == nil {
			return zero, errors.New("keyword highlight rule flags are required")
		}
		out := api.KeywordHighlightRule{
			ID:            rule.ID,
			Keyword:       rule.Keyword,
			Foreground:    rule.Foreground,
			CaseSensitive: *rule.CaseSensitive,
			WholeWord:     *rule.WholeWord,
		}
		if rule.Background != nil {
			out.Background = *rule.Background
		}
		config.Rules = append(config.Rules, out)
	}
	return config, nil
}

// parseMetadataPatch mirrors metadataPatchSchema in metadata-schema.ts.
func parseMetadataPatch(body []byte) (api.OpenSSHMetadataPatch, error) {
	var zero api.OpenSSHMetadataPatch
	var probe struct {
		DisplayName       api.Opt[string]                `json:"displayName"`
		Group             api.Opt[string]                `json:"group"`
		Color             api.Opt[string]                `json:"color"`
		Icon              api.Opt[string]                `json:"icon"`
		KeywordHighlights api.Opt[keywordHighlightsBody] `json:"keywordHighlights"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return zero, errors.New("invalid metadata")
	}
	for _, field := range []struct {
		name  string
		value api.Opt[string]
		max   int
	}{
		{"displayName", probe.DisplayName, 200},
		// A group is a folder path ("Production/EU/Edge"), so the cap covers
		// several nested names rather than a single one.
		{"group", probe.Group, 300},
		{"color", probe.Color, 64},
		{"icon", probe.Icon, 64},
	} {
		if field.value.Valid && len(field.value.Value) > field.max {
			return zero, fmt.Errorf("%s must be at most %d characters", field.name, field.max)
		}
	}
	patch := api.OpenSSHMetadataPatch{
		DisplayName: probe.DisplayName,
		Group:       probe.Group,
		Color:       probe.Color,
		Icon:        probe.Icon,
	}
	if probe.KeywordHighlights.Set {
		if !probe.KeywordHighlights.Valid {
			patch.KeywordHighlights = api.Null[api.HostKeywordHighlightConfig]()
		} else {
			config, err := parseKeywordHighlights(probe.KeywordHighlights.Value)
			if err != nil {
				return zero, err
			}
			patch.KeywordHighlights = api.Some(config)
		}
	}
	if !patch.DisplayName.Set && !patch.Group.Set && !patch.Color.Set &&
		!patch.Icon.Set && !patch.KeywordHighlights.Set {
		return zero, errors.New("at least one metadata field is required")
	}
	return patch, nil
}

// RegisterProfileRoutes mirrors registerProfileRoutes: Muxus-owned Telnet and
// serial hosts.
func RegisterProfileRoutes(r chi.Router, db *persist.DB) {
	r.Get("/api/profiles", func(w http.ResponseWriter, _ *http.Request) {
		profiles, err := db.ListSavedHostProfiles()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, savedHostProfilesResponse{Profiles: profiles})
	})

	r.Put("/api/profiles", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		input, err := parseSavedProfile(body)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		record, err := db.SaveSavedHostProfile(input)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Patch("/api/profiles/{id}/metadata", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		patch, err := parseMetadataPatch(body)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		record, err := db.UpdateSavedHostMetadata(chi.URLParam(req, "id"), patch)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Delete("/api/profiles/{id}", func(w http.ResponseWriter, req *http.Request) {
		deleted, err := db.DeleteSavedHostProfile(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, deletedResponse{Deleted: deleted})
	})
}
