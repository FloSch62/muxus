package persist

import (
	"database/sql"
	"errors"
	"math"
	"path/filepath"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

var defaultSessionLoggingPolicy = api.SessionLoggingPolicyInput{
	Enabled:      false,
	CaptureInput: false,
	MaxPartBytes: 5 * 1024 * 1024,
	MaxParts:     10,
}

type loggingPolicyRow struct {
	enabled      int
	captureInput int
	maxPartBytes int64
	maxParts     int64
}

func (d *DB) loggingPolicyRow(profileKey string) (*loggingPolicyRow, error) {
	var r loggingPolicyRow
	err := d.db.QueryRow(`
        SELECT enabled, capture_input, max_part_bytes, max_parts
        FROM session_logging_policies WHERE profile_key = ?
      `, profileKey).Scan(&r.enabled, &r.captureInput, &r.maxPartBytes, &r.maxParts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SessionLoggingPolicy resolves the effective policy for profileKey: an
// exact override when present, otherwise the "*" defaults, otherwise the
// built-in defaults.
func (d *DB) SessionLoggingPolicy(profileKey string) (api.SessionLoggingPolicy, error) {
	var zero api.SessionLoggingPolicy
	if err := requireNonEmpty(profileKey, "profileKey"); err != nil {
		return zero, err
	}
	exact, err := d.loggingPolicyRow(profileKey)
	if err != nil {
		return zero, err
	}
	row := exact
	if row == nil && profileKey != "*" {
		if row, err = d.loggingPolicyRow("*"); err != nil {
			return zero, err
		}
	}
	policy := api.SessionLoggingPolicy{
		ProfileKey:   profileKey,
		Enabled:      defaultSessionLoggingPolicy.Enabled,
		CaptureInput: defaultSessionLoggingPolicy.CaptureInput,
		MaxPartBytes: defaultSessionLoggingPolicy.MaxPartBytes,
		MaxParts:     defaultSessionLoggingPolicy.MaxParts,
		Overridden:   exact != nil,
	}
	if row != nil {
		policy.Enabled = row.enabled == 1
		policy.CaptureInput = row.captureInput == 1
		policy.MaxPartBytes = int(row.maxPartBytes)
		policy.MaxParts = int(row.maxParts)
	}
	return policy, nil
}

// SaveSessionLoggingPolicy stores an override (or the "*" defaults) and
// returns the effective policy.
func (d *DB) SaveSessionLoggingPolicy(profileKey string, input api.SessionLoggingPolicyInput) (api.SessionLoggingPolicy, error) {
	var zero api.SessionLoggingPolicy
	if err := requireNonEmpty(profileKey, "profileKey"); err != nil {
		return zero, err
	}
	if err := validateSessionLoggingPolicy(input); err != nil {
		return zero, err
	}
	if _, err := d.db.Exec(`
        INSERT INTO session_logging_policies(
          profile_key, enabled, capture_input, max_part_bytes, max_parts
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_key) DO UPDATE SET
          enabled = excluded.enabled,
          capture_input = excluded.capture_input,
          max_part_bytes = excluded.max_part_bytes,
          max_parts = excluded.max_parts,
          updated_at = CURRENT_TIMESTAMP
      `,
		profileKey,
		boolToInt(input.Enabled),
		boolToInt(input.CaptureInput),
		input.MaxPartBytes,
		input.MaxParts,
	); err != nil {
		return zero, err
	}
	return d.SessionLoggingPolicy(profileKey)
}

// DeleteSessionLoggingPolicy removes an override, reporting whether one
// existed.
func (d *DB) DeleteSessionLoggingPolicy(profileKey string) (bool, error) {
	if err := requireNonEmpty(profileKey, "profileKey"); err != nil {
		return false, err
	}
	result, err := d.db.Exec("DELETE FROM session_logging_policies WHERE profile_key = ?", profileKey)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return changes > 0, nil
}

// SessionHistorySettings reads the singleton settings row.
func (d *DB) SessionHistorySettings() (api.SessionHistorySettings, error) {
	var (
		settings        api.SessionHistorySettings
		storageLocation sql.NullString
		maxAgeDays      sql.NullInt64
	)
	err := d.db.QueryRow(`
        SELECT storage_location, max_total_bytes, min_free_bytes,
               min_free_percent, max_age_days
        FROM session_history_settings WHERE singleton = 1
      `).Scan(
		&storageLocation, &settings.MaxTotalBytes, &settings.MinFreeBytes,
		&settings.MinFreePercent, &maxAgeDays,
	)
	if err != nil {
		return settings, err
	}
	settings.StorageLocation = optionalString(storageLocation)
	if maxAgeDays.Valid {
		days := int(maxAgeDays.Int64)
		settings.MaxAgeDays = &days
	}
	return settings, nil
}

// SaveSessionHistorySettings validates and stores the singleton settings
// row.
func (d *DB) SaveSessionHistorySettings(input api.SessionHistorySettingsInput) (api.SessionHistorySettings, error) {
	var zero api.SessionHistorySettings
	if err := validateSessionHistorySettings(input); err != nil {
		return zero, err
	}
	var storageLocation any
	if trimmed := strings.TrimSpace(input.StorageLocation); trimmed != "" {
		storageLocation = trimmed
	}
	var maxAgeDays any
	if input.MaxAgeDays != nil {
		maxAgeDays = *input.MaxAgeDays
	}
	if _, err := d.db.Exec(`
        UPDATE session_history_settings
        SET storage_location = ?,
            max_total_bytes = ?,
            min_free_bytes = ?,
            min_free_percent = ?,
            max_age_days = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1
      `,
		storageLocation,
		input.MaxTotalBytes,
		input.MinFreeBytes,
		input.MinFreePercent,
		maxAgeDays,
	); err != nil {
		return zero, err
	}
	return d.SessionHistorySettings()
}

// FinalizeSessionHistorySeparation removes every payload row and
// history-only table from the application database after the worker has
// imported version-6 history. A one-time VACUUM reclaims old BLOB pages when
// an upgrade actually imported payloads.
func (d *DB) FinalizeSessionHistorySeparation(compact bool) error {
	if _, err := d.db.Exec(`
      DROP TRIGGER IF EXISTS session_log_events_fts_insert;
      DROP TRIGGER IF EXISTS session_log_events_fts_delete;
      DROP TRIGGER IF EXISTS session_log_events_fts_update;
      DROP TABLE IF EXISTS session_log_events_fts;
      DROP TABLE IF EXISTS session_log_events;
      DROP TABLE IF EXISTS session_logs;
      PRAGMA wal_checkpoint(TRUNCATE);
    `); err != nil {
		return err
	}
	if compact {
		if _, err := d.db.Exec("VACUUM"); err != nil {
			return err
		}
	}
	return nil
}

// HasLegacySessionHistory reports whether pre-separation history rows still
// live in this database.
func (d *DB) HasLegacySessionHistory() (bool, error) {
	table, err := scanExists(d.db.QueryRow(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'session_logs'
      `))
	if err != nil || !table {
		return false, err
	}
	return scanExists(d.db.QueryRow("SELECT 1 FROM session_logs LIMIT 1"))
}

func moveSessionLoggingPolicy(q querier, previousKey, nextKey string) error {
	if _, err := q.Exec(`
        INSERT INTO session_logging_policies(
          profile_key, enabled, capture_input, max_part_bytes, max_parts
        )
        SELECT ?, enabled, capture_input, max_part_bytes, max_parts
        FROM session_logging_policies
        WHERE profile_key = ?
        ON CONFLICT(profile_key) DO UPDATE SET
          enabled = excluded.enabled,
          capture_input = excluded.capture_input,
          max_part_bytes = excluded.max_part_bytes,
          max_parts = excluded.max_parts,
          updated_at = CURRENT_TIMESTAMP
      `, nextKey, previousKey); err != nil {
		return err
	}
	_, err := q.Exec("DELETE FROM session_logging_policies WHERE profile_key = ?", previousKey)
	return err
}

func validateSessionLoggingPolicy(input api.SessionLoggingPolicyInput) error {
	if input.MaxPartBytes < 64*1024 || input.MaxPartBytes > 1024*1024*1024 {
		return errors.New("maxPartBytes must be between 64 KiB and 1 GiB")
	}
	if input.MaxParts < 1 || input.MaxParts > 1000 {
		return errors.New("maxParts must be between 1 and 1000")
	}
	return nil
}

func validateSessionHistorySettings(input api.SessionHistorySettingsInput) error {
	if input.StorageLocation != "" {
		if !filepath.IsAbs(input.StorageLocation) {
			return errors.New("storageLocation must be an absolute path")
		}
		location := filepath.Clean(input.StorageLocation)
		if filepath.Dir(location) == location {
			return errors.New("storageLocation cannot be the filesystem root")
		}
	}
	if input.MaxTotalBytes < 64*1024*1024 {
		return errors.New("maxTotalBytes must be at least 64 MiB")
	}
	if input.MinFreeBytes < 0 {
		return errors.New("minFreeBytes must be a non-negative integer")
	}
	if math.IsNaN(input.MinFreePercent) || math.IsInf(input.MinFreePercent, 0) ||
		input.MinFreePercent < 0 || input.MinFreePercent > 100 {
		return errors.New("minFreePercent must be between 0 and 100")
	}
	if input.MaxAgeDays != nil && *input.MaxAgeDays < 1 {
		return errors.New("maxAgeDays must be a positive integer when enabled")
	}
	return nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
