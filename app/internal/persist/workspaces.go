package persist

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

// WorkspaceInput mirrors the saveWorkspace parameter in database.ts (ID
// present = update).
type WorkspaceInput struct {
	ID              string
	Name            string
	Layout          any
	MultiExecGroups []api.WorkspaceMultiExecGroup
}

// DefaultTerminalSnapshotGraceSeconds is the TS pruneTerminalSnapshots
// default.
const DefaultTerminalSnapshotGraceSeconds = 3600

const workspaceSelect = `
        SELECT id, name, layout_json, multi_exec_groups_json, is_startup,
               created_at, updated_at, last_opened_at
        FROM workspaces
      `

type workspaceRow struct {
	id           string
	name         string
	layoutJSON   string
	groupsJSON   string
	isStartup    int
	createdAt    string
	updatedAt    string
	lastOpenedAt sql.NullString
}

func scanWorkspaceRow(scan func(...any) error) (*workspaceRow, error) {
	var r workspaceRow
	err := scan(
		&r.id, &r.name, &r.layoutJSON, &r.groupsJSON, &r.isStartup,
		&r.createdAt, &r.updatedAt, &r.lastOpenedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func workspaceFromRow(r *workspaceRow) (api.WorkspaceRecord, error) {
	var layout any
	if err := json.Unmarshal([]byte(r.layoutJSON), &layout); err != nil {
		return api.WorkspaceRecord{}, err
	}
	groups := []api.WorkspaceMultiExecGroup{}
	if err := json.Unmarshal([]byte(r.groupsJSON), &groups); err != nil {
		return api.WorkspaceRecord{}, err
	}
	return api.WorkspaceRecord{
		ID:              r.id,
		Name:            r.name,
		Layout:          layout,
		MultiExecGroups: groups,
		IsStartup:       r.isStartup == 1,
		CreatedAt:       r.createdAt,
		UpdatedAt:       r.updatedAt,
		LastOpenedAt:    optionalString(r.lastOpenedAt),
	}, nil
}

// SaveWorkspace creates or replaces a workspace.
func (d *DB) SaveWorkspace(input WorkspaceInput) (api.WorkspaceRecord, error) {
	var zero api.WorkspaceRecord
	if err := requireNonEmpty(input.Name, "name"); err != nil {
		return zero, err
	}
	if err := AssertSecretFree(input.Layout, "workspace.layout"); err != nil {
		return zero, err
	}
	if err := AssertSecretFree(input.MultiExecGroups, "workspace.multiExecGroups"); err != nil {
		return zero, err
	}
	id := input.ID
	if id == "" {
		var err error
		if id, err = newID(); err != nil {
			return zero, err
		}
	}
	layout, err := json.Marshal(input.Layout)
	if err != nil {
		return zero, errors.New("workspace.layout must be JSON-serializable")
	}
	groups := input.MultiExecGroups
	if groups == nil {
		groups = []api.WorkspaceMultiExecGroup{}
	}
	groupsJSON, err := json.Marshal(groups)
	if err != nil {
		return zero, err
	}
	if _, err := d.db.Exec(`
        INSERT INTO workspaces(id, name, layout_json, multi_exec_groups_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          layout_json = excluded.layout_json,
          multi_exec_groups_json = excluded.multi_exec_groups_json,
          updated_at = CURRENT_TIMESTAMP
      `, id, strings.TrimSpace(input.Name), string(layout), string(groupsJSON)); err != nil {
		return zero, err
	}
	record, err := d.Workspace(id)
	if err != nil {
		return zero, err
	}
	return *record, nil
}

// Workspace returns one workspace, or nil when it does not exist.
func (d *DB) Workspace(id string) (*api.WorkspaceRecord, error) {
	row, err := scanWorkspaceRow(d.db.QueryRow(workspaceSelect+"WHERE id = ?", id).Scan)
	if err != nil || row == nil {
		return nil, err
	}
	record, err := workspaceFromRow(row)
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// LatestWorkspace returns the most recently opened (or updated) workspace.
func (d *DB) LatestWorkspace() (*api.WorkspaceRecord, error) {
	row, err := scanWorkspaceRow(d.db.QueryRow(workspaceSelect + `
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
        LIMIT 1
      `).Scan)
	if err != nil || row == nil {
		return nil, err
	}
	record, err := workspaceFromRow(row)
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// StartupWorkspace returns the workspace selected for startup, if any.
func (d *DB) StartupWorkspace() (*api.WorkspaceRecord, error) {
	row, err := scanWorkspaceRow(d.db.QueryRow(workspaceSelect + `
        WHERE is_startup = 1
        LIMIT 1
      `).Scan)
	if err != nil || row == nil {
		return nil, err
	}
	record, err := workspaceFromRow(row)
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// ListWorkspaceSummaries lists workspaces without their layout payloads.
func (d *DB) ListWorkspaceSummaries() ([]api.WorkspaceSummary, error) {
	rows, err := d.db.Query(`
        SELECT id, name, is_startup, created_at, updated_at, last_opened_at
        FROM workspaces
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []api.WorkspaceSummary{}
	for rows.Next() {
		var (
			summary      api.WorkspaceSummary
			isStartup    int
			lastOpenedAt sql.NullString
		)
		if err := rows.Scan(
			&summary.ID, &summary.Name, &isStartup,
			&summary.CreatedAt, &summary.UpdatedAt, &lastOpenedAt,
		); err != nil {
			return nil, err
		}
		summary.IsStartup = isStartup == 1
		summary.LastOpenedAt = optionalString(lastOpenedAt)
		result = append(result, summary)
	}
	return result, rows.Err()
}

// ListWorkspaces lists full workspace records.
func (d *DB) ListWorkspaces() ([]api.WorkspaceRecord, error) {
	rows, err := d.db.Query(workspaceSelect + `
        ORDER BY COALESCE(last_opened_at, updated_at) DESC, name COLLATE NOCASE
      `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []api.WorkspaceRecord{}
	for rows.Next() {
		row, err := scanWorkspaceRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		record, err := workspaceFromRow(row)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

// RenameWorkspace renames a workspace, returning nil when it does not exist.
func (d *DB) RenameWorkspace(id, name string) (*api.WorkspaceRecord, error) {
	if err := requireNonEmpty(name, "name"); err != nil {
		return nil, err
	}
	result, err := d.db.Exec(`
        UPDATE workspaces
        SET name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, strings.TrimSpace(name), id)
	if err != nil {
		return nil, err
	}
	changes, err := result.RowsAffected()
	if err != nil || changes == 0 {
		return nil, err
	}
	return d.Workspace(id)
}

// OpenWorkspace stamps last_opened_at, returning nil when the workspace does
// not exist.
func (d *DB) OpenWorkspace(id string) (*api.WorkspaceRecord, error) {
	result, err := d.db.Exec(`
        UPDATE workspaces
        SET last_opened_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, id)
	if err != nil {
		return nil, err
	}
	changes, err := result.RowsAffected()
	if err != nil || changes == 0 {
		return nil, err
	}
	return d.Workspace(id)
}

// SetStartupWorkspace marks id as the single startup workspace; nil clears
// the selection.
func (d *DB) SetStartupWorkspace(id *string) (*api.WorkspaceRecord, error) {
	if id != nil {
		existing, err := d.Workspace(*id)
		if err != nil || existing == nil {
			return nil, err
		}
	}
	tx, err := d.begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE workspaces SET is_startup = 0 WHERE is_startup = 1"); err != nil {
		return nil, err
	}
	if id != nil {
		if _, err := tx.Exec("UPDATE workspaces SET is_startup = 1 WHERE id = ?", *id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if id == nil {
		return nil, nil
	}
	return d.Workspace(*id)
}

// DeleteWorkspace removes a workspace.
func (d *DB) DeleteWorkspace(id string) (bool, error) {
	result, err := d.db.Exec("DELETE FROM workspaces WHERE id = ?", id)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return changes > 0, nil
}

// SaveTerminalSnapshot stores or replaces one tab's serialized scrollback.
func (d *DB) SaveTerminalSnapshot(tabID, data string) error {
	if err := requireNonEmpty(tabID, "tabId"); err != nil {
		return err
	}
	_, err := d.db.Exec(`
        INSERT INTO terminal_snapshots(tab_id, data, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(tab_id) DO UPDATE SET
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `, tabID, data)
	return err
}

// TerminalSnapshot returns one tab's snapshot, or nil when absent.
func (d *DB) TerminalSnapshot(tabID string) (*api.TerminalSnapshotRecord, error) {
	var record api.TerminalSnapshotRecord
	err := d.db.QueryRow(
		"SELECT tab_id, data, updated_at FROM terminal_snapshots WHERE tab_id = ?", tabID,
	).Scan(&record.TabID, &record.Data, &record.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// PruneTerminalSnapshots drops snapshots for tabs no stored workspace
// references. Recent rows are spared: a fresh tab's snapshot can land before
// its first layout autosave.
func (d *DB) PruneTerminalSnapshots(graceSeconds int) (int, error) {
	referenced := make(map[string]bool)
	workspaces, err := d.ListWorkspaces()
	if err != nil {
		return 0, err
	}
	for _, workspace := range workspaces {
		if layout, ok := workspace.Layout.(map[string]any); ok {
			collectLayoutTabIDs(layout["root"], referenced)
		}
	}
	rows, err := d.db.Query(
		"SELECT tab_id FROM terminal_snapshots WHERE updated_at <= datetime('now', ?)",
		fmt.Sprintf("-%d seconds", graceSeconds),
	)
	if err != nil {
		return 0, err
	}
	stale := []string{}
	for rows.Next() {
		var tabID string
		if err := rows.Scan(&tabID); err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, tabID)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	pruned := 0
	for _, tabID := range stale {
		if referenced[tabID] {
			continue
		}
		if _, err := d.db.Exec("DELETE FROM terminal_snapshots WHERE tab_id = ?", tabID); err != nil {
			return pruned, err
		}
		pruned++
	}
	return pruned, nil
}

// collectLayoutTabIDs walks a stored layout tree defensively — its shape is
// schemaless in the database.
func collectLayoutTabIDs(node any, into map[string]bool) {
	record, ok := node.(map[string]any)
	if !ok {
		return
	}
	if record["type"] == "split" {
		if children, ok := record["children"].([]any); ok {
			for _, child := range children {
				collectLayoutTabIDs(child, into)
			}
			return
		}
	}
	tabs, ok := record["tabs"].([]any)
	if !ok {
		return
	}
	for _, tab := range tabs {
		if entry, ok := tab.(map[string]any); ok {
			if id, ok := entry["id"].(string); ok {
				into[id] = true
			}
		}
	}
}
