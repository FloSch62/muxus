package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
	"github.com/FloSch62/muxus/app/internal/server"
)

// defaultBodyLimit mirrors Fastify's default bodyLimit for JSON routes.
const defaultBodyLimit = 1 << 20

// readJSONBody reads a request body up to limit, answering 413 like Fastify
// when it overflows. The bool reports whether the caller may proceed.
func readJSONBody(w http.ResponseWriter, req *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			server.WriteJSON(w, http.StatusRequestEntityTooLarge,
				api.ErrorBody{Message: "request body is too large"})
		} else {
			server.WriteJSON(w, http.StatusBadRequest, api.ErrorBody{Message: "invalid request body"})
		}
		return nil, false
	}
	return body, true
}

// writeInternalError mirrors sendError's fallback: unknown failures become a
// 500 carrying the error message.
func writeInternalError(w http.ResponseWriter, err error) {
	server.WriteJSON(w, http.StatusInternalServerError, api.ErrorBody{Message: err.Error()})
}

func writeBadRequest(w http.ResponseWriter, message string) {
	server.WriteJSON(w, http.StatusBadRequest, api.ErrorBody{Message: message})
}

func writeNotFound(w http.ResponseWriter, message string) {
	server.WriteJSON(w, http.StatusNotFound, api.ErrorBody{Message: message})
}

// deletedResponse is the { deleted } body shared by the delete routes.
type deletedResponse struct {
	Deleted bool `json:"deleted"`
}

// The parsers below mirror the zod schemas in workspaces.ts: same
// constraints and refine messages, applied in the same order, so the first
// failure matches zod's issues[0].

type workspaceConnectionRef struct {
	Source string `json:"source"`
	ID     string `json:"id"`
}

func (ref *workspaceConnectionRef) validate() error {
	if ref == nil {
		return errors.New("workspace tab connection is required")
	}
	if ref.Source != "openssh" && ref.Source != "profile" {
		return fmt.Errorf("workspace tab connection source %q not recognized", ref.Source)
	}
	if ref.ID == "" {
		return errors.New("workspace tab connection id is required")
	}
	return nil
}

// workspaceTab carries one workspaceTabSchema variant; Kind selects which
// fields are meaningful.
type workspaceTab struct {
	ID    string
	Kind  string
	Title string

	// terminal
	Profile        api.SessionProfile
	CwdHint        *string
	Color          *string
	OfferReconnect bool

	// sftp / editor
	Connection *workspaceConnectionRef
	Path       *string
}

// MarshalJSON emits only the active variant's keys so the stored layout
// matches the zod-normalized shape.
func (t workspaceTab) MarshalJSON() ([]byte, error) {
	if t.Kind == "terminal" {
		return json.Marshal(struct {
			ID             string             `json:"id"`
			Kind           string             `json:"kind"`
			Title          string             `json:"title"`
			Profile        api.SessionProfile `json:"profile"`
			CwdHint        *string            `json:"cwdHint,omitempty"`
			Color          *string            `json:"color,omitempty"`
			OfferReconnect bool               `json:"offerReconnect"`
		}{t.ID, t.Kind, t.Title, t.Profile, t.CwdHint, t.Color, t.OfferReconnect})
	}
	return json.Marshal(struct {
		ID         string                  `json:"id"`
		Kind       string                  `json:"kind"`
		Title      string                  `json:"title"`
		Connection *workspaceConnectionRef `json:"connection"`
		Path       *string                 `json:"path,omitempty"`
	}{t.ID, t.Kind, t.Title, t.Connection, t.Path})
}

func parseWorkspaceTab(raw json.RawMessage) (workspaceTab, error) {
	var zero workspaceTab
	var probe struct {
		ID             *string                 `json:"id"`
		Kind           string                  `json:"kind"`
		Title          *string                 `json:"title"`
		Profile        json.RawMessage         `json:"profile"`
		CwdHint        *string                 `json:"cwdHint"`
		Color          *string                 `json:"color"`
		OfferReconnect *bool                   `json:"offerReconnect"`
		Connection     *workspaceConnectionRef `json:"connection"`
		Path           *string                 `json:"path"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return zero, errors.New("invalid workspace tab")
	}
	if probe.ID == nil || *probe.ID == "" {
		return zero, errors.New("workspace tab id is required")
	}
	if probe.Title == nil || len(*probe.Title) > 500 {
		return zero, errors.New("workspace tab title must be at most 500 characters")
	}
	tab := workspaceTab{ID: *probe.ID, Kind: probe.Kind, Title: *probe.Title}
	switch probe.Kind {
	case "terminal":
		if probe.Profile == nil {
			return zero, errors.New("terminal tab profile is required")
		}
		profile, err := api.ParseSessionProfile(probe.Profile)
		if err != nil {
			return zero, err
		}
		if probe.Color != nil && len(*probe.Color) > 32 {
			return zero, errors.New("terminal tab color must be at most 32 characters")
		}
		if probe.OfferReconnect == nil {
			return zero, errors.New("terminal tab offerReconnect is required")
		}
		tab.Profile = profile
		tab.CwdHint = probe.CwdHint
		tab.Color = probe.Color
		tab.OfferReconnect = *probe.OfferReconnect
	case "sftp", "editor":
		if err := probe.Connection.validate(); err != nil {
			return zero, err
		}
		tab.Connection = probe.Connection
		tab.Path = probe.Path
	default:
		return zero, fmt.Errorf("workspace tab kind %q not recognized", probe.Kind)
	}
	return tab, nil
}

// workspaceNode carries one workspaceNodeSchema variant; Type selects which
// fields are meaningful.
type workspaceNode struct {
	ID   string
	Type string

	// pane
	Tabs        []workspaceTab
	ActiveTabID *string

	// split
	Direction string
	Ratio     float64
	Children  [2]*workspaceNode
}

func (n *workspaceNode) MarshalJSON() ([]byte, error) {
	if n.Type == "split" {
		return json.Marshal(struct {
			ID        string            `json:"id"`
			Type      string            `json:"type"`
			Direction string            `json:"direction"`
			Ratio     float64           `json:"ratio"`
			Children  [2]*workspaceNode `json:"children"`
		}{n.ID, n.Type, n.Direction, n.Ratio, n.Children})
	}
	return json.Marshal(struct {
		ID          string         `json:"id"`
		Type        string         `json:"type"`
		Tabs        []workspaceTab `json:"tabs"`
		ActiveTabID *string        `json:"activeTabId,omitempty"`
	}{n.ID, n.Type, n.Tabs, n.ActiveTabID})
}

func parseWorkspaceNode(raw json.RawMessage) (*workspaceNode, error) {
	var probe struct {
		ID          *string            `json:"id"`
		Type        string             `json:"type"`
		Tabs        *[]json.RawMessage `json:"tabs"`
		ActiveTabID *string            `json:"activeTabId"`
		Direction   string             `json:"direction"`
		Ratio       *float64           `json:"ratio"`
		Children    []json.RawMessage  `json:"children"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, errors.New("invalid workspace node")
	}
	if probe.ID == nil || *probe.ID == "" {
		return nil, errors.New("workspace node id is required")
	}
	node := &workspaceNode{ID: *probe.ID, Type: probe.Type}
	switch probe.Type {
	case "pane":
		if probe.Tabs == nil {
			return nil, errors.New("pane tabs are required")
		}
		node.Tabs = make([]workspaceTab, 0, len(*probe.Tabs))
		for _, rawTab := range *probe.Tabs {
			tab, err := parseWorkspaceTab(rawTab)
			if err != nil {
				return nil, err
			}
			node.Tabs = append(node.Tabs, tab)
		}
		node.ActiveTabID = probe.ActiveTabID
	case "split":
		if probe.Direction != "horizontal" && probe.Direction != "vertical" {
			return nil, fmt.Errorf("split direction %q not recognized", probe.Direction)
		}
		if probe.Ratio == nil || *probe.Ratio < 0.1 || *probe.Ratio > 0.9 {
			return nil, errors.New("split ratio must be between 0.1 and 0.9")
		}
		if len(probe.Children) != 2 {
			return nil, errors.New("split must have exactly two children")
		}
		node.Direction = probe.Direction
		node.Ratio = *probe.Ratio
		for index, rawChild := range probe.Children {
			child, err := parseWorkspaceNode(rawChild)
			if err != nil {
				return nil, err
			}
			node.Children[index] = child
		}
	default:
		return nil, fmt.Errorf("workspace node type %q not recognized", probe.Type)
	}
	return node, nil
}

type workspaceLayout struct {
	Version      int            `json:"version"`
	Root         *workspaceNode `json:"root"`
	ActivePaneID *string        `json:"activePaneId,omitempty"`
}

func parseWorkspaceLayout(raw json.RawMessage) (*workspaceLayout, error) {
	var probe struct {
		Version      *float64        `json:"version"`
		Root         json.RawMessage `json:"root"`
		ActivePaneID *string         `json:"activePaneId"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, errors.New("invalid workspace layout")
	}
	if probe.Version == nil || *probe.Version != 1 {
		return nil, errors.New("workspace layout version must be 1")
	}
	if probe.Root == nil {
		return nil, errors.New("workspace layout root is required")
	}
	layout := &workspaceLayout{Version: 1, ActivePaneID: probe.ActivePaneID}
	if !bytes.Equal(bytes.TrimSpace(probe.Root), []byte("null")) {
		root, err := parseWorkspaceNode(probe.Root)
		if err != nil {
			return nil, err
		}
		layout.Root = root
	}
	if err := validateWorkspaceLayout(layout); err != nil {
		return nil, err
	}
	return layout, nil
}

// validateWorkspaceLayout ports workspaceLayoutSchema's superRefine: node,
// pane, and tab identifiers must be unambiguous, and focus references must
// resolve.
func validateWorkspaceLayout(layout *workspaceLayout) error {
	if layout.Root == nil {
		return nil
	}
	nodeIDs := map[string]bool{}
	paneIDs := map[string]bool{}
	tabIDs := map[string]bool{}
	var walk func(node *workspaceNode) error
	walk = func(node *workspaceNode) error {
		if nodeIDs[node.ID] {
			return fmt.Errorf("duplicate workspace node id %q", node.ID)
		}
		nodeIDs[node.ID] = true
		if node.Type == "split" {
			if err := walk(node.Children[0]); err != nil {
				return err
			}
			return walk(node.Children[1])
		}
		paneIDs[node.ID] = true
		localTabs := map[string]bool{}
		for _, tab := range node.Tabs {
			if tabIDs[tab.ID] {
				return fmt.Errorf("duplicate workspace tab id %q", tab.ID)
			}
			tabIDs[tab.ID] = true
			localTabs[tab.ID] = true
		}
		if node.ActiveTabID != nil && *node.ActiveTabID != "" && !localTabs[*node.ActiveTabID] {
			return fmt.Errorf("active tab %q is not in pane %q", *node.ActiveTabID, node.ID)
		}
		return nil
	}
	if err := walk(layout.Root); err != nil {
		return err
	}
	if layout.ActivePaneID != nil && *layout.ActivePaneID != "" && !paneIDs[*layout.ActivePaneID] {
		return fmt.Errorf("active pane %q does not exist", *layout.ActivePaneID)
	}
	return nil
}

func parseMultiExecGroup(raw json.RawMessage) (api.WorkspaceMultiExecGroup, error) {
	var zero api.WorkspaceMultiExecGroup
	var probe struct {
		ID     *string   `json:"id"`
		Name   *string   `json:"name"`
		TabIDs *[]string `json:"tabIds"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return zero, errors.New("invalid multi-exec group")
	}
	if probe.ID == nil || *probe.ID == "" {
		return zero, errors.New("multi-exec group id is required")
	}
	if probe.Name == nil {
		return zero, errors.New("multi-exec group name is required")
	}
	name := strings.TrimSpace(*probe.Name)
	if name == "" || len(name) > 200 {
		return zero, errors.New("multi-exec group name must be 1-200 characters")
	}
	if probe.TabIDs == nil || len(*probe.TabIDs) < 2 {
		return zero, fmt.Errorf("multi-exec group %q needs at least two tabs", name)
	}
	seen := make(map[string]bool, len(*probe.TabIDs))
	for _, tabID := range *probe.TabIDs {
		if tabID == "" {
			return zero, fmt.Errorf("multi-exec group %q contains an empty tab id", name)
		}
		if seen[tabID] {
			return zero, fmt.Errorf("multi-exec group %q contains duplicate tabs", name)
		}
		seen[tabID] = true
	}
	return api.WorkspaceMultiExecGroup{ID: *probe.ID, Name: name, TabIDs: *probe.TabIDs}, nil
}

type workspaceSaveBody struct {
	ID              string
	Name            string
	Layout          *workspaceLayout
	MultiExecGroups []api.WorkspaceMultiExecGroup
}

func parseWorkspaceSave(body []byte) (*workspaceSaveBody, error) {
	var probe struct {
		ID              *string           `json:"id"`
		Name            *string           `json:"name"`
		Layout          json.RawMessage   `json:"layout"`
		MultiExecGroups []json.RawMessage `json:"multiExecGroups"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, errors.New("invalid workspace")
	}
	save := &workspaceSaveBody{MultiExecGroups: []api.WorkspaceMultiExecGroup{}}
	if probe.ID != nil {
		if *probe.ID == "" {
			return nil, errors.New("workspace id must not be empty")
		}
		save.ID = *probe.ID
	}
	if probe.Name == nil {
		return nil, errors.New("workspace name is required")
	}
	name := strings.TrimSpace(*probe.Name)
	if name == "" || len(name) > 200 {
		return nil, errors.New("workspace name must be 1-200 characters")
	}
	save.Name = name
	if probe.Layout == nil {
		return nil, errors.New("workspace layout is required")
	}
	layout, err := parseWorkspaceLayout(probe.Layout)
	if err != nil {
		return nil, err
	}
	save.Layout = layout
	for _, raw := range probe.MultiExecGroups {
		group, err := parseMultiExecGroup(raw)
		if err != nil {
			return nil, err
		}
		save.MultiExecGroups = append(save.MultiExecGroups, group)
	}
	if err := validateWorkspaceSave(save); err != nil {
		return nil, err
	}
	return save, nil
}

// validateWorkspaceSave ports workspaceSaveSchema's superRefine: multi-exec
// groups must be unambiguous and may only target terminal tabs that exist in
// the layout.
func validateWorkspaceSave(save *workspaceSaveBody) error {
	ids := map[string]bool{}
	names := map[string]bool{}
	terminalTabIDs := map[string]bool{}
	var collect func(node *workspaceNode)
	collect = func(node *workspaceNode) {
		if node == nil {
			return
		}
		if node.Type == "split" {
			collect(node.Children[0])
			collect(node.Children[1])
			return
		}
		for _, tab := range node.Tabs {
			if tab.Kind == "terminal" {
				terminalTabIDs[tab.ID] = true
			}
		}
	}
	collect(save.Layout.Root)
	for _, group := range save.MultiExecGroups {
		if ids[group.ID] {
			return fmt.Errorf("duplicate multi-exec group id %q", group.ID)
		}
		ids[group.ID] = true
		name := strings.ToLower(strings.TrimSpace(group.Name))
		if names[name] {
			return fmt.Errorf("duplicate multi-exec group name %q", group.Name)
		}
		names[name] = true
		for _, tabID := range group.TabIDs {
			if !terminalTabIDs[tabID] {
				return fmt.Errorf("multi-exec group %q references unknown terminal tab %q", group.Name, tabID)
			}
		}
	}
	return nil
}

type workspaceListResponse struct {
	Workspaces []api.WorkspaceSummary `json:"workspaces"`
}

type workspaceEnvelope struct {
	Workspace *api.WorkspaceRecord `json:"workspace"`
}

// RegisterWorkspaceRoutes mirrors registerWorkspaceRoutes.
func RegisterWorkspaceRoutes(r chi.Router, db *persist.DB) {
	r.Get("/api/workspaces", func(w http.ResponseWriter, _ *http.Request) {
		summaries, err := db.ListWorkspaceSummaries()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, workspaceListResponse{Workspaces: summaries})
	})

	r.Get("/api/workspaces/latest", func(w http.ResponseWriter, _ *http.Request) {
		record, err := db.LatestWorkspace()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, workspaceEnvelope{Workspace: record})
	})

	r.Get("/api/workspaces/startup", func(w http.ResponseWriter, _ *http.Request) {
		record, err := db.StartupWorkspace()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, workspaceEnvelope{Workspace: record})
	})

	r.Put("/api/workspaces/startup", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var probe struct {
			ID api.Opt[string] `json:"id"`
		}
		if err := json.Unmarshal(body, &probe); err != nil || !probe.ID.Set ||
			(probe.ID.Valid && probe.ID.Value == "") {
			writeBadRequest(w, "invalid startup workspace")
			return
		}
		var id *string
		if probe.ID.Valid {
			id = &probe.ID.Value
		}
		record, err := db.SetStartupWorkspace(id)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if id != nil && record == nil {
			writeNotFound(w, "workspace not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, workspaceEnvelope{Workspace: record})
	})

	r.Get("/api/workspaces/{id}", func(w http.ResponseWriter, req *http.Request) {
		record, err := db.Workspace(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if record == nil {
			writeNotFound(w, "workspace not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Put("/api/workspaces", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		save, err := parseWorkspaceSave(body)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		saved, err := db.SaveWorkspace(persist.WorkspaceInput{
			ID:              save.ID,
			Name:            save.Name,
			Layout:          save.Layout,
			MultiExecGroups: save.MultiExecGroups,
		})
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if _, err := db.PruneTerminalSnapshots(persist.DefaultTerminalSnapshotGraceSeconds); err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, saved)
	})

	r.Patch("/api/workspaces/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var probe struct {
			Name *string `json:"name"`
		}
		if err := json.Unmarshal(body, &probe); err != nil || probe.Name == nil {
			writeBadRequest(w, "invalid workspace name")
			return
		}
		name := strings.TrimSpace(*probe.Name)
		if name == "" || len(name) > 200 {
			writeBadRequest(w, "workspace name must be 1-200 characters")
			return
		}
		record, err := db.RenameWorkspace(chi.URLParam(req, "id"), name)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if record == nil {
			writeNotFound(w, "workspace not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Post("/api/workspaces/{id}/open", func(w http.ResponseWriter, req *http.Request) {
		record, err := db.OpenWorkspace(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if record == nil {
			writeNotFound(w, "workspace not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, record)
	})

	r.Delete("/api/workspaces/{id}", func(w http.ResponseWriter, req *http.Request) {
		deleted, err := db.DeleteWorkspace(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if deleted {
			if _, err := db.PruneTerminalSnapshots(persist.DefaultTerminalSnapshotGraceSeconds); err != nil {
				writeInternalError(w, err)
				return
			}
		}
		server.WriteJSON(w, http.StatusOK, deletedResponse{Deleted: deleted})
	})
}
