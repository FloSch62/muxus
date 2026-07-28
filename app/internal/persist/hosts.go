package persist

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

// NativeConnectionInput mirrors NativeConnectionInput in database.ts.
type NativeConnectionInput struct {
	Kind            string // 'ssh' | 'local' | 'serial' | 'telnet'
	Name            string
	Config          map[string]any
	CredentialRefID string
}

// CredentialRefInput mirrors CredentialRefInput in database.ts.
type CredentialRefInput struct {
	// Provider is the logical OS store adapter, for example "os-keychain".
	Provider string
	// Service is the stable application/service namespace in that store.
	Service string
	// Account is the account/key used to retrieve the secret from the OS store.
	Account string
	Label   string
}

// CredentialRefRecord mirrors CredentialRefRecord in database.ts.
type CredentialRefRecord struct {
	ID string
	CredentialRefInput
}

const metadataByAliasSQL = `
      SELECT
        profiles.id,
        profiles.name,
        profiles.ssh_alias,
        profiles.group_id,
        profiles.sort_order,
        profiles.color,
        profiles.icon,
        profiles.keyword_highlights_json,
        profiles.last_connected_at,
        profiles.connect_count,
        groups.name AS group_name
      FROM connection_profiles AS profiles
      LEFT JOIN connection_groups AS groups ON groups.id = profiles.group_id
      WHERE profiles.kind = 'openssh' AND profiles.ssh_alias = ?
    `

type profileRow struct {
	id              string
	name            string
	sshAlias        sql.NullString
	groupID         sql.NullString
	sortOrder       sql.NullInt64
	color           sql.NullString
	icon            sql.NullString
	keywordJSON     sql.NullString
	lastConnectedAt sql.NullString
	connectCount    int64
	groupName       sql.NullString
}

func metadataRowByAlias(q querier, alias string) (*profileRow, error) {
	var r profileRow
	err := q.QueryRow(metadataByAliasSQL, alias).Scan(
		&r.id, &r.name, &r.sshAlias, &r.groupID, &r.sortOrder, &r.color, &r.icon,
		&r.keywordJSON, &r.lastConnectedAt, &r.connectCount, &r.groupName,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func metadataFromProfileRow(r *profileRow) api.OpenSSHProfileMetadata {
	alias := r.sshAlias.String
	meta := api.OpenSSHProfileMetadata{
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
		meta.SortOrder = &order
	}
	if r.name != alias {
		meta.DisplayName = r.name
	}
	return meta
}

func keywordHighlightsFromJSON(value sql.NullString) *api.HostKeywordHighlightConfig {
	if !value.Valid {
		return nil
	}
	// Same defensive shape check as the TS reader: anything without a boolean
	// inheritGlobal and an array of rules reads back as absent.
	var probe struct {
		InheritGlobal *bool             `json:"inheritGlobal"`
		Rules         []json.RawMessage `json:"rules"`
	}
	if err := json.Unmarshal([]byte(value.String), &probe); err != nil {
		return nil
	}
	if probe.InheritGlobal == nil || probe.Rules == nil {
		return nil
	}
	var config api.HostKeywordHighlightConfig
	if err := json.Unmarshal([]byte(value.String), &config); err != nil {
		return nil
	}
	return &config
}

// OpenSSHMetadata returns the stored metadata for each alias that has a row.
func (d *DB) OpenSSHMetadata(aliases []string) (map[string]api.OpenSSHProfileMetadata, error) {
	result := make(map[string]api.OpenSSHProfileMetadata)
	for _, alias := range aliases {
		row, err := metadataRowByAlias(d.db, alias)
		if err != nil {
			return nil, err
		}
		if row == nil {
			continue
		}
		result[alias] = metadataFromProfileRow(row)
	}
	return result, nil
}

// UpdateOpenSSHMetadata upserts the profile row for alias and applies patch.
func (d *DB) UpdateOpenSSHMetadata(alias string, patch api.OpenSSHMetadataPatch) (api.OpenSSHProfileMetadata, error) {
	var zero api.OpenSSHProfileMetadata
	if err := requireNonEmpty(alias, "alias"); err != nil {
		return zero, err
	}
	current, err := d.ensureOpenSSHProfile(d.db, alias)
	if err != nil {
		return zero, err
	}
	displayName := current.name
	if patch.DisplayName.Set {
		displayName = alias
		if patch.DisplayName.Valid {
			if trimmed := strings.TrimSpace(patch.DisplayName.Value); trimmed != "" {
				displayName = trimmed
			}
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
		displayName,
		groupID,
		patchedNullString(patch.Color, current.color),
		patchedNullString(patch.Icon, current.icon),
		patchedKeywordJSON(patch.KeywordHighlights, current.keywordJSON),
		current.id,
	); err != nil {
		return zero, err
	}
	row, err := metadataRowByAlias(d.db, alias)
	if err != nil {
		return zero, err
	}
	return metadataFromProfileRow(row), nil
}

func optValue(opt api.Opt[string]) *string {
	if opt.Valid {
		return &opt.Value
	}
	return nil
}

func patchedNullString(patch api.Opt[string], current sql.NullString) any {
	if !patch.Set {
		return sqlNullable(current)
	}
	if !patch.Valid {
		return nil
	}
	return patch.Value
}

func patchedKeywordJSON(patch api.Opt[api.HostKeywordHighlightConfig], current sql.NullString) any {
	if !patch.Set {
		return sqlNullable(current)
	}
	if !patch.Valid {
		return nil
	}
	raw, err := json.Marshal(patch.Value)
	if err != nil {
		// A HostKeywordHighlightConfig always marshals; keep the signature
		// usable inline.
		return nil
	}
	return string(raw)
}

// ReorderManagedHosts persists one complete visual group order across both
// host sources. Rows for OpenSSH hosts are created lazily so even
// otherwise-unmodified hosts can participate in sorting; saved Telnet/serial
// hosts must already exist.
func (d *DB) ReorderManagedHosts(refs []api.ManagedHostRef) error {
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		key := "profile:" + ref.ID
		if ref.Kind == "ssh" {
			key = "ssh:" + ref.Alias
		}
		if seen[key] {
			return errors.New("host order contains duplicates")
		}
		seen[key] = true
	}
	for _, ref := range refs {
		if ref.Kind == "ssh" {
			if err := requireNonEmpty(ref.Alias, "alias"); err != nil {
				return err
			}
		} else if err := requireNonEmpty(ref.ID, "id"); err != nil {
			return err
		}
	}
	tx, err := d.begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for index, ref := range refs {
		id := ref.ID
		if ref.Kind == "profile" {
			exists, err := scanExists(tx.QueryRow(
				`SELECT 1 FROM connection_profiles WHERE id = ? AND kind IN ('serial', 'telnet')`, ref.ID,
			))
			if err != nil {
				return err
			}
			if !exists {
				return errors.New("saved host not found")
			}
		} else {
			row, err := d.ensureOpenSSHProfile(tx, ref.Alias)
			if err != nil {
				return err
			}
			id = row.id
		}
		if _, err := tx.Exec(`
        UPDATE connection_profiles
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, index, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RecordOpenSSHConnection bumps the recency counters for alias, creating the
// metadata row when needed.
func (d *DB) RecordOpenSSHConnection(alias string) (api.OpenSSHProfileMetadata, error) {
	var zero api.OpenSSHProfileMetadata
	if err := requireNonEmpty(alias, "alias"); err != nil {
		return zero, err
	}
	current, err := d.ensureOpenSSHProfile(d.db, alias)
	if err != nil {
		return zero, err
	}
	if _, err := d.db.Exec(`
        UPDATE connection_profiles
        SET last_connected_at = CURRENT_TIMESTAMP,
            connect_count = connect_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, current.id); err != nil {
		return zero, err
	}
	row, err := metadataRowByAlias(d.db, alias)
	if err != nil {
		return zero, err
	}
	return metadataFromProfileRow(row), nil
}

// RenameOpenSSHAlias preserves the stable profile ID when a Host alias is
// renamed externally.
func (d *DB) RenameOpenSSHAlias(previousAlias, nextAlias string) error {
	if previousAlias == nextAlias {
		return nil
	}
	if err := requireNonEmpty(previousAlias, "previousAlias"); err != nil {
		return err
	}
	if err := requireNonEmpty(nextAlias, "nextAlias"); err != nil {
		return err
	}
	previous, err := metadataRowByAlias(d.db, previousAlias)
	if err != nil {
		return err
	}
	next, err := metadataRowByAlias(d.db, nextAlias)
	if err != nil {
		return err
	}
	tx, err := d.begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := moveSessionLoggingPolicy(tx, "ssh:"+previousAlias, "ssh:"+nextAlias); err != nil {
		return err
	}
	if previous == nil {
		return tx.Commit()
	}
	if next != nil {
		lastConnectedCompare := optionalString(next.lastConnectedAt)
		if _, err := tx.Exec(`
            UPDATE connection_profiles
            SET connect_count = connect_count + ?,
                last_connected_at = CASE
                  WHEN last_connected_at IS NULL OR ? > last_connected_at THEN ?
                  ELSE last_connected_at
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
			next.connectCount,
			lastConnectedCompare,
			sqlNullable(next.lastConnectedAt),
			previous.id,
		); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM connection_profiles WHERE id = ?", next.id); err != nil {
			return err
		}
	}
	name := previous.name
	if previous.name == previousAlias {
		name = nextAlias
	}
	if _, err := tx.Exec(`
          UPDATE connection_profiles
          SET ssh_alias = ?, name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, nextAlias, name, previous.id); err != nil {
		return err
	}
	return tx.Commit()
}

// UpsertCredentialRef stores or refreshes an OS credential-store reference.
func (d *DB) UpsertCredentialRef(input CredentialRefInput) (CredentialRefRecord, error) {
	var zero CredentialRefRecord
	if err := requireNonEmpty(input.Provider, "provider"); err != nil {
		return zero, err
	}
	if err := requireNonEmpty(input.Service, "service"); err != nil {
		return zero, err
	}
	if err := requireNonEmpty(input.Account, "account"); err != nil {
		return zero, err
	}
	var id string
	err := d.db.QueryRow(`
        SELECT id FROM credential_refs
        WHERE provider = ? AND service = ? AND account = ?
      `, input.Provider, input.Service, input.Account).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		if id, err = newID(); err != nil {
			return zero, err
		}
	} else if err != nil {
		return zero, err
	}
	label := strings.TrimSpace(input.Label)
	var labelParam any
	if label != "" {
		labelParam = label
	}
	if _, err := d.db.Exec(`
        INSERT INTO credential_refs(id, provider, service, account, label)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, service, account) DO UPDATE SET
          label = excluded.label,
          updated_at = CURRENT_TIMESTAMP
      `, id, input.Provider, input.Service, input.Account, labelParam); err != nil {
		return zero, err
	}
	record := CredentialRefRecord{ID: id, CredentialRefInput: input}
	record.Label = label
	return record, nil
}

// CreateNativeConnection stores a non-OpenSSH profile and returns its ID.
func (d *DB) CreateNativeConnection(input NativeConnectionInput) (string, error) {
	if err := requireNonEmpty(input.Name, "name"); err != nil {
		return "", err
	}
	if err := AssertSecretFree(input.Config, ""); err != nil {
		return "", err
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	config := input.Config
	if config == nil {
		config = map[string]any{}
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	var credentialRef any
	if input.CredentialRefID != "" {
		credentialRef = input.CredentialRefID
	}
	if _, err := d.db.Exec(`
        INSERT INTO connection_profiles(
          id, kind, name, native_config_json, credential_ref_id
        ) VALUES (?, ?, ?, ?, ?)
      `, id, input.Kind, strings.TrimSpace(input.Name), string(configJSON), credentialRef); err != nil {
		return "", err
	}
	return id, nil
}

func (d *DB) ensureOpenSSHProfile(q querier, alias string) (*profileRow, error) {
	existing, err := metadataRowByAlias(q, alias)
	if err != nil || existing != nil {
		return existing, err
	}
	id, err := newID()
	if err != nil {
		return nil, err
	}
	if _, err := q.Exec(`
        INSERT INTO connection_profiles(id, kind, name, ssh_alias)
        VALUES (?, 'openssh', ?, ?)
      `, id, alias, alias); err != nil {
		return nil, err
	}
	return metadataRowByAlias(q, alias)
}

// groupIDForName reuses group names case-insensitively so typing "work" and
// "Work" cannot silently create two visually indistinguishable sidebar
// groups. A spelling that differs only by case updates the row instead of
// being discarded, so renaming a folder to fix its capitalization actually
// takes effect.
func (d *DB) groupIDForName(q querier, name *string) (sql.NullString, error) {
	none := sql.NullString{}
	if name == nil {
		return none, nil
	}
	normalized := strings.TrimSpace(*name)
	if normalized == "" {
		return none, nil
	}
	var id, existingName string
	err := q.QueryRow(
		"SELECT id, name FROM connection_groups WHERE name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1",
		normalized,
	).Scan(&id, &existingName)
	if errors.Is(err, sql.ErrNoRows) {
		newGroupID, err := newID()
		if err != nil {
			return none, err
		}
		if _, err := q.Exec("INSERT INTO connection_groups(id, name) VALUES (?, ?)", newGroupID, normalized); err != nil {
			return none, err
		}
		return sql.NullString{String: newGroupID, Valid: true}, nil
	}
	if err != nil {
		return none, err
	}
	if existingName != normalized {
		if _, err := q.Exec(
			"UPDATE connection_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			normalized, id,
		); err != nil {
			return none, err
		}
	}
	return sql.NullString{String: id, Valid: true}, nil
}
