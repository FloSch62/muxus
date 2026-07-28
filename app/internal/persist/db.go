// Package persist owns the Muxus application database: a 1:1 port of
// server/src/persistence/database.ts. Schema, migration history, pragmas,
// and query semantics stay identical, so a database created by the Electron
// build opens unchanged here and vice versa.
package persist

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	gonanoid "github.com/matoous/go-nanoid/v2"
	_ "modernc.org/sqlite"
)

const memoryFilename = ":memory:"

// DB exposes the same method surface as the TS MuxusDatabase class.
type DB struct {
	db       *sql.DB
	filename string
}

// querier abstracts *sql.DB and *sql.Tx so helpers can run inside the
// explicit transactions ported from the TS class.
type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Open creates or opens the database at filename (":memory:" for an
// in-memory database) and applies pending migrations.
func Open(filename string) (*DB, error) {
	if filename != memoryFilename {
		// 0700/0600 keep host metadata private to the owning user.
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			return nil, err
		}
	}
	handle, err := sql.Open("sqlite", dsn(filename))
	if err != nil {
		return nil, err
	}
	// The TS class owns one synchronous connection. Explicit transactions and
	// per-connection pragmas rely on the same discipline, and a second pooled
	// connection would see an independent copy of a :memory: database.
	handle.SetMaxOpenConns(1)
	handle.SetMaxIdleConns(1)
	if err := handle.Ping(); err != nil {
		handle.Close()
		return nil, err
	}
	if filename != memoryFilename {
		// Permissions may be controlled by the platform/filesystem.
		_ = os.Chmod(filename, 0o600)
	}
	d := &DB{db: handle, filename: filename}
	if err := d.migrate(); err != nil {
		handle.Close()
		return nil, err
	}
	return d, nil
}

func dsn(filename string) string {
	query := url.Values{}
	// _txlock=immediate makes db.Begin issue BEGIN IMMEDIATE, matching the
	// TS class. Pragmas ride on the DSN so a reopened pooled connection gets
	// them again.
	query.Set("_txlock", "immediate")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	if filename != memoryFilename {
		query.Add("_pragma", "journal_mode(WAL)")
		query.Add("_pragma", "synchronous(NORMAL)")
	}
	return "file:" + filename + "?" + query.Encode()
}

// Filename is the path this database was opened with.
func (d *DB) Filename() string { return d.filename }

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) begin() (*sql.Tx, error) { return d.db.Begin() }

func newID() (string, error) {
	// Same default alphabet and length (21) as the nanoid() calls in TS.
	return gonanoid.New()
}

func requireNonEmpty(value, name string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", name)
	}
	return nil
}

// optionalString ports optionalString: NULL and the empty string both read
// back as absent.
func optionalString(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}

// sqlNullable ports nullableString for statement parameters: a stored empty
// string stays an empty string, only NULL maps to nil.
func sqlNullable(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}

func scanExists(row *sql.Row) (bool, error) {
	var one int
	err := row.Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
