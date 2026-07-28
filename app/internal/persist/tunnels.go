package persist

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

const tunnelSelect = `
        SELECT id, name, target, ssh_options_json, type, bind_port, target_host, target_port, created_at, updated_at
        FROM tunnels
      `

type tunnelRow struct {
	id         string
	name       sql.NullString
	target     string
	sshJSON    sql.NullString
	tunnelType string
	bindPort   int64
	targetHost sql.NullString
	targetPort sql.NullInt64
	createdAt  string
	updatedAt  string
}

func scanTunnelRow(scan func(...any) error) (*tunnelRow, error) {
	var r tunnelRow
	err := scan(
		&r.id, &r.name, &r.target, &r.sshJSON, &r.tunnelType, &r.bindPort,
		&r.targetHost, &r.targetPort, &r.createdAt, &r.updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func tunnelFromRow(r *tunnelRow) (api.TunnelRecord, error) {
	record := api.TunnelRecord{
		ID:        r.id,
		Name:      optionalString(r.name),
		Target:    r.target,
		Type:      api.ForwardType(r.tunnelType),
		BindPort:  int(r.bindPort),
		CreatedAt: r.createdAt,
		UpdatedAt: r.updatedAt,
	}
	if r.sshJSON.Valid {
		var options *api.TunnelSSHOptions
		if err := json.Unmarshal([]byte(r.sshJSON.String), &options); err != nil {
			return record, err
		}
		record.SSHOptions = options
	}
	if record.Type != api.ForwardDynamic {
		record.TargetHost = r.targetHost.String
		port := int(r.targetPort.Int64)
		record.TargetPort = &port
	}
	return record, nil
}

// ListTunnels returns all saved tunnels in display order.
func (d *DB) ListTunnels() ([]api.TunnelRecord, error) {
	rows, err := d.db.Query(tunnelSelect + `
        ORDER BY COALESCE(NULLIF(name, ''), target) COLLATE NOCASE, created_at
      `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []api.TunnelRecord{}
	for rows.Next() {
		row, err := scanTunnelRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		record, err := tunnelFromRow(row)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

// SaveTunnel creates (no ID) or updates (ID present) a saved tunnel.
func (d *DB) SaveTunnel(input api.TunnelInput) (api.TunnelRecord, error) {
	var zero api.TunnelRecord
	if err := requireNonEmpty(input.Target, "target"); err != nil {
		return zero, err
	}
	if err := AssertSecretFree(input.SSHOptions, "tunnel.sshOptions"); err != nil {
		return zero, err
	}
	dynamic := input.Type == api.ForwardDynamic
	if !dynamic && (strings.TrimSpace(input.TargetHost) == "" || input.TargetPort == 0) {
		return zero, errors.New("targetHost and targetPort are required for local/remote tunnels")
	}
	id := input.ID
	if id == "" {
		var err error
		if id, err = newID(); err != nil {
			return zero, err
		}
	}
	var name any
	if trimmed := strings.TrimSpace(input.Name); trimmed != "" {
		name = trimmed
	}
	var sshOptions any
	if input.SSHOptions != nil {
		raw, err := json.Marshal(input.SSHOptions)
		if err != nil {
			return zero, err
		}
		sshOptions = string(raw)
	}
	var targetHost, targetPort any
	if !dynamic {
		targetHost = strings.TrimSpace(input.TargetHost)
		targetPort = input.TargetPort
	}
	if _, err := d.db.Exec(`
        INSERT INTO tunnels(id, name, target, ssh_options_json, type, bind_port, target_host, target_port)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          target = excluded.target,
          ssh_options_json = excluded.ssh_options_json,
          type = excluded.type,
          bind_port = excluded.bind_port,
          target_host = excluded.target_host,
          target_port = excluded.target_port,
          updated_at = CURRENT_TIMESTAMP
      `,
		id, name, strings.TrimSpace(input.Target), sshOptions,
		string(input.Type), input.BindPort, targetHost, targetPort,
	); err != nil {
		return zero, err
	}
	row, err := scanTunnelRow(d.db.QueryRow(tunnelSelect+"WHERE id = ?", id).Scan)
	if err != nil {
		return zero, err
	}
	return tunnelFromRow(row)
}

// DeleteTunnel removes a saved tunnel.
func (d *DB) DeleteTunnel(id string) (bool, error) {
	result, err := d.db.Exec("DELETE FROM tunnels WHERE id = ?", id)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return changes > 0, nil
}
