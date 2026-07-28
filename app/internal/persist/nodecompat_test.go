package persist_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
)

// TestNodeCreatedDatabaseCompat proves on-disk compatibility with the
// TypeScript implementation: a database created and populated by the built
// server opens unchanged here, and rows written from Go read back correctly
// in Node. Skipped when node or the built server is unavailable.
func TestNodeCreatedDatabaseCompat(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	distModule := filepath.Join(repoRoot, "server", "dist", "persistence", "database.js")
	if _, err := os.Stat(distModule); err != nil {
		t.Skipf("built server module unavailable: %v", err)
	}
	nodeBinary, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	moduleURL := (&url.URL{Scheme: "file", Path: distModule}).String()

	directory := t.TempDir()
	databasePath := filepath.Join(directory, "muxus.sqlite")

	createScript := filepath.Join(directory, "create.mjs")
	if err := os.WriteFile(createScript, []byte(fmt.Sprintf(`
import { MuxusDatabase } from %q;
const db = new MuxusDatabase(process.argv[2]);
db.saveWorkspace({ name: 'FromNode', layout: { version: 1, root: null } });
db.updateOpenSshMetadata('router', { group: 'Lab', color: '#123456' });
db.saveTunnel({ name: 'DB', target: 'web', type: 'local', bindPort: 5432, targetHost: 'localhost', targetPort: 5432 });
db.saveSessionLoggingPolicy('ssh:router', { enabled: true, captureInput: false, maxPartBytes: 1048576, maxParts: 4 });
db.saveTerminalSnapshot('tab-1', 'scrollback');
db.close();
`, moduleURL)), 0o600); err != nil {
		t.Fatal(err)
	}
	runNode(t, nodeBinary, createScript, databasePath)

	db, err := persist.Open(databasePath)
	if err != nil {
		t.Fatalf("open node-created database: %v", err)
	}
	if applied := must(db.AppliedMigrations()); len(applied) != 10 {
		t.Fatalf("applied = %+v", applied)
	}
	metadata := must(db.OpenSSHMetadata([]string{"router"}))["router"]
	if metadata.Group != "Lab" || metadata.Color != "#123456" {
		t.Fatalf("metadata = %+v", metadata)
	}
	workspaces := must(db.ListWorkspaceSummaries())
	if len(workspaces) != 1 || workspaces[0].Name != "FromNode" {
		t.Fatalf("workspaces = %+v", workspaces)
	}
	tunnels := must(db.ListTunnels())
	if len(tunnels) != 1 || tunnels[0].Name != "DB" || tunnels[0].BindPort != 5432 ||
		tunnels[0].TargetPort == nil || *tunnels[0].TargetPort != 5432 {
		t.Fatalf("tunnels = %+v", tunnels)
	}
	policy := must(db.SessionLoggingPolicy("ssh:router"))
	if !policy.Enabled || policy.MaxPartBytes != 1048576 || policy.MaxParts != 4 || !policy.Overridden {
		t.Fatalf("policy = %+v", policy)
	}
	if snapshot := must(db.TerminalSnapshot("tab-1")); snapshot == nil || snapshot.Data != "scrollback" {
		t.Fatalf("snapshot = %+v", snapshot)
	}

	must(db.UpdateOpenSSHMetadata("router", api.OpenSSHMetadataPatch{
		DisplayName: api.Some("Router X"),
	}))
	if err := db.SaveTerminalSnapshot("tab-2", "from go"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	readScript := filepath.Join(directory, "read.mjs")
	if err := os.WriteFile(readScript, []byte(fmt.Sprintf(`
import { MuxusDatabase } from %q;
const db = new MuxusDatabase(process.argv[2]);
console.log(JSON.stringify({
  meta: db.openSshMetadata(['router']).get('router'),
  snapshot: db.terminalSnapshot('tab-2'),
}));
db.close();
`, moduleURL)), 0o600); err != nil {
		t.Fatal(err)
	}
	output := runNode(t, nodeBinary, readScript, databasePath)
	var readBack struct {
		Meta struct {
			DisplayName string `json:"displayName"`
			Group       string `json:"group"`
		} `json:"meta"`
		Snapshot struct {
			Data string `json:"data"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal(output, &readBack); err != nil {
		t.Fatalf("parse node output %q: %v", output, err)
	}
	if readBack.Meta.DisplayName != "Router X" || readBack.Meta.Group != "Lab" {
		t.Fatalf("node read metadata = %+v", readBack.Meta)
	}
	if readBack.Snapshot.Data != "from go" {
		t.Fatalf("node read snapshot = %+v", readBack.Snapshot)
	}
}

func runNode(t *testing.T, nodeBinary, script, databasePath string) []byte {
	t.Helper()
	cmd := exec.Command(nodeBinary, script, databasePath)
	output, err := cmd.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			t.Fatalf("node %s failed: %v\n%s", script, err, exit.Stderr)
		}
		t.Fatalf("node %s failed: %v", script, err)
	}
	return output
}
