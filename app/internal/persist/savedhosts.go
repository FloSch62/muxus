package persist

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

const savedHostSelect = `
        SELECT profiles.id, profiles.kind, profiles.name, profiles.native_config_json,
               profiles.group_id, profiles.sort_order, profiles.color, profiles.icon,
               profiles.keyword_highlights_json, profiles.last_connected_at,
               profiles.connect_count, profiles.created_at, profiles.updated_at,
               groups.name AS group_name
        FROM connection_profiles AS profiles
        LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
      `

type savedHostRow struct {
	id              string
	kind            string
	name            string
	configJSON      string
	groupID         sql.NullString
	sortOrder       sql.NullInt64
	color           sql.NullString
	icon            sql.NullString
	keywordJSON     sql.NullString
	lastConnectedAt sql.NullString
	connectCount    int64
	createdAt       string
	updatedAt       string
	groupName       sql.NullString
}

func scanSavedHostRow(scan func(...any) error) (*savedHostRow, error) {
	var r savedHostRow
	err := scan(
		&r.id, &r.kind, &r.name, &r.configJSON, &r.groupID, &r.sortOrder,
		&r.color, &r.icon, &r.keywordJSON, &r.lastConnectedAt, &r.connectCount,
		&r.createdAt, &r.updatedAt, &r.groupName,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func savedHostFromRow(r *savedHostRow) (api.SavedHostProfile, error) {
	var config map[string]any
	if err := json.Unmarshal([]byte(r.configJSON), &config); err != nil {
		return api.SavedHostProfile{}, err
	}
	profile := make(api.SavedHostSessionProfile, len(config)+2)
	profile["kind"] = r.kind
	for key, value := range config {
		profile[key] = value
	}
	profile["profileId"] = r.id
	metadata := api.OpenSSHProfileMetadata{
		ProfileID:         r.id,
		Group:             optionalString(r.groupName),
		Color:             optionalString(r.color),
		Icon:              optionalString(r.icon),
		KeywordHighlights: keywordHighlightsFromJSON(r.keywordJSON),
		LastConnectedAt:   optionalString(r.lastConnectedAt),
		ConnectCount:      int(r.connectCount),
	}
	if r.sortOrder.Valid {
		order := int(r.sortOrder.Int64)
		metadata.SortOrder = &order
	}
	return api.SavedHostProfile{
		ID:        r.id,
		Kind:      r.kind,
		Name:      r.name,
		Profile:   profile,
		Metadata:  metadata,
		CreatedAt: r.createdAt,
		UpdatedAt: r.updatedAt,
	}, nil
}

// ListSavedHostProfiles returns all saved Telnet/serial hosts in sidebar
// order.
func (d *DB) ListSavedHostProfiles() ([]api.SavedHostProfile, error) {
	rows, err := d.db.Query(savedHostSelect + `
        WHERE profiles.kind IN ('serial', 'telnet')
        ORDER BY profiles.sort_order, profiles.name COLLATE NOCASE
      `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []api.SavedHostProfile{}
	for rows.Next() {
		row, err := scanSavedHostRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		record, err := savedHostFromRow(row)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

// SaveSavedHostProfile creates (no ID) or updates (ID present) a saved
// Telnet/serial host.
func (d *DB) SaveSavedHostProfile(input api.SavedHostProfileInput) (api.SavedHostProfile, error) {
	var zero api.SavedHostProfile
	if err := requireNonEmpty(input.Name, "name"); err != nil {
		return zero, err
	}
	kind, _ := input.Profile["kind"].(string)
	config := make(map[string]any, len(input.Profile))
	for key, value := range input.Profile {
		if key == "kind" || key == "profileId" {
			continue
		}
		config[key] = value
	}
	if err := AssertSecretFree(config, "profile.config"); err != nil {
		return zero, err
	}
	id := input.ID
	if id == "" {
		var err error
		if id, err = newID(); err != nil {
			return zero, err
		}
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return zero, err
	}
	if input.ID != "" {
		var existingKind string
		err := d.db.QueryRow(
			`SELECT kind FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`, id,
		).Scan(&existingKind)
		if errors.Is(err, sql.ErrNoRows) {
			return zero, errors.New("saved host not found")
		}
		if err != nil {
			return zero, err
		}
		if _, err := d.db.Exec(`
          UPDATE connection_profiles
          SET kind = ?, name = ?, native_config_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, kind, strings.TrimSpace(input.Name), string(configJSON), id); err != nil {
			return zero, err
		}
	} else if _, err := d.db.Exec(`
          INSERT INTO connection_profiles(id, kind, name, native_config_json)
          VALUES (?, ?, ?, ?)
        `, id, kind, strings.TrimSpace(input.Name), string(configJSON)); err != nil {
		return zero, err
	}
	record, err := d.SavedHostProfile(id)
	if err != nil {
		return zero, err
	}
	if record == nil {
		return zero, errors.New("saved host not found")
	}
	return *record, nil
}

// SavedHostProfile returns one saved host, or nil when it does not exist.
func (d *DB) SavedHostProfile(id string) (*api.SavedHostProfile, error) {
	row, err := scanSavedHostRow(d.db.QueryRow(savedHostSelect+`
        WHERE profiles.id = ? AND profiles.kind IN ('serial', 'telnet')
      `, id).Scan)
	if err != nil || row == nil {
		return nil, err
	}
	record, err := savedHostFromRow(row)
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// UpdateSavedHostMetadata applies a sidebar-organization patch to one saved
// host.
func (d *DB) UpdateSavedHostMetadata(id string, patch api.OpenSSHMetadataPatch) (api.SavedHostProfile, error) {
	var zero api.SavedHostProfile
	current, err := scanSavedHostRow(d.db.QueryRow(savedHostSelect+`
        WHERE profiles.id = ? AND profiles.kind IN ('serial', 'telnet')
      `, id).Scan)
	if err != nil {
		return zero, err
	}
	if current == nil {
		return zero, errors.New("saved host not found")
	}
	name := current.name
	if patch.DisplayName.Set && patch.DisplayName.Valid {
		if trimmed := strings.TrimSpace(patch.DisplayName.Value); trimmed != "" {
			name = trimmed
		}
	}
	groupID := current.groupID
	if patch.Group.Set {
		groupID, err = d.groupIDForName(d.db, optValue(patch.Group))
		if err != nil {
			return zero, err
		}
	}
	if _, err := d.db.Exec(`
        UPDATE connection_profiles
        SET name = ?,
            group_id = ?,
            color = ?,
            icon = ?,
            keyword_highlights_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
		name,
		groupID,
		patchedNullString(patch.Color, current.color),
		patchedNullString(patch.Icon, current.icon),
		patchedKeywordJSON(patch.KeywordHighlights, current.keywordJSON),
		id,
	); err != nil {
		return zero, err
	}
	record, err := d.SavedHostProfile(id)
	if err != nil {
		return zero, err
	}
	if record == nil {
		return zero, errors.New("saved host not found")
	}
	return *record, nil
}

// RecordSavedHostConnection bumps the recency counters for one saved host.
func (d *DB) RecordSavedHostConnection(id string) error {
	_, err := d.db.Exec(`
        UPDATE connection_profiles
        SET last_connected_at = CURRENT_TIMESTAMP,
            connect_count = connect_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND kind IN ('serial', 'telnet')
      `, id)
	return err
}

// DeleteSavedHostProfile removes a saved host and its per-host logging
// policy.
func (d *DB) DeleteSavedHostProfile(id string) (bool, error) {
	result, err := d.db.Exec(
		`DELETE FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`, id,
	)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	deleted := changes > 0
	if deleted {
		if _, err := d.db.Exec(
			"DELETE FROM session_logging_policies WHERE profile_key = ?", "profile:"+id,
		); err != nil {
			return false, err
		}
	}
	return deleted, nil
}
