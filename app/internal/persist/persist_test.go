package persist_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/persist"
)

func openMemory(t *testing.T) *persist.DB {
	t.Helper()
	db, err := persist.Open(":memory:")
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// must panics instead of taking *testing.T so it can wrap multi-valued DB
// calls inline; the panic still fails the calling test with a stack trace.
func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func mustErrContain(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q, got nil", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("expected error containing %q, got %q", substr, err.Error())
	}
}

func TestAppliesVersionedSchema(t *testing.T) {
	db := openMemory(t)
	applied := must(db.AppliedMigrations())
	expected := []persist.Migration{
		{Version: 1, Name: "foundation"},
		{Version: 2, Name: "tunnels"},
		{Version: 3, Name: "host-sort-order"},
		{Version: 4, Name: "tunnel-ssh-options"},
		{Version: 5, Name: "host-keyword-highlights"},
		{Version: 6, Name: "persistent-session-history"},
		{Version: 7, Name: "bounded-session-history-settings"},
		{Version: 8, Name: "named-workspace-session-sets"},
		{Version: 9, Name: "drop-favorites"},
		{Version: 10, Name: "terminal-scrollback-snapshots"},
	}
	if !reflect.DeepEqual(applied, expected) {
		t.Fatalf("applied migrations = %+v", applied)
	}
}

func layoutWith(tabID string) map[string]any {
	return map[string]any{
		"version": 1,
		"root": map[string]any{
			"id":   "pane-1",
			"type": "pane",
			"tabs": []any{
				map[string]any{
					"id":             tabID,
					"kind":           "terminal",
					"title":          "Router",
					"profile":        map[string]any{"kind": "ssh", "target": "router"},
					"offerReconnect": true,
				},
			},
		},
	}
}

func TestTerminalSnapshotStoresAndReplaces(t *testing.T) {
	db := openMemory(t)
	if err := db.SaveTerminalSnapshot("tab-1", "first"); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveTerminalSnapshot("tab-1", "second"); err != nil {
		t.Fatal(err)
	}
	snapshot := must(db.TerminalSnapshot("tab-1"))
	if snapshot == nil || snapshot.TabID != "tab-1" || snapshot.Data != "second" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if missing := must(db.TerminalSnapshot("tab-2")); missing != nil {
		t.Fatalf("expected no snapshot, got %+v", missing)
	}
}

func TestTerminalSnapshotPrunesUnreferenced(t *testing.T) {
	db := openMemory(t)
	must(db.SaveWorkspace(persist.WorkspaceInput{Name: "Ops", Layout: layoutWith("kept-tab")}))
	if err := db.SaveTerminalSnapshot("kept-tab", "kept"); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveTerminalSnapshot("orphan-tab", "orphan"); err != nil {
		t.Fatal(err)
	}
	if pruned := must(db.PruneTerminalSnapshots(0)); pruned != 1 {
		t.Fatalf("pruned = %d", pruned)
	}
	if kept := must(db.TerminalSnapshot("kept-tab")); kept == nil {
		t.Fatal("kept-tab snapshot removed")
	}
	if orphan := must(db.TerminalSnapshot("orphan-tab")); orphan != nil {
		t.Fatal("orphan-tab snapshot survived")
	}
}

func TestTerminalSnapshotSparesFresh(t *testing.T) {
	db := openMemory(t)
	if err := db.SaveTerminalSnapshot("brand-new-tab", "early output"); err != nil {
		t.Fatal(err)
	}
	if pruned := must(db.PruneTerminalSnapshots(persist.DefaultTerminalSnapshotGraceSeconds)); pruned != 0 {
		t.Fatalf("pruned = %d", pruned)
	}
	if fresh := must(db.TerminalSnapshot("brand-new-tab")); fresh == nil {
		t.Fatal("fresh snapshot removed")
	}
}

func TestSessionLoggingPolicyDefaultsAndOverrides(t *testing.T) {
	db := openMemory(t)

	initial := must(db.SessionLoggingPolicy("ssh:production"))
	if initial.Enabled || initial.CaptureInput || initial.MaxPartBytes != 5*1024*1024 ||
		initial.MaxParts != 10 || initial.Overridden {
		t.Fatalf("initial policy = %+v", initial)
	}

	must(db.SaveSessionLoggingPolicy("*", api.SessionLoggingPolicyInput{
		Enabled: true, CaptureInput: false, MaxPartBytes: 1024 * 1024, MaxParts: 4,
	}))
	must(db.SaveSessionLoggingPolicy("ssh:production", api.SessionLoggingPolicyInput{
		Enabled: false, CaptureInput: true, MaxPartBytes: 2 * 1024 * 1024, MaxParts: 2,
	}))

	production := must(db.SessionLoggingPolicy("ssh:production"))
	if production.Enabled || !production.CaptureInput || production.MaxPartBytes != 2*1024*1024 ||
		production.MaxParts != 2 || !production.Overridden {
		t.Fatalf("production policy = %+v", production)
	}
	staging := must(db.SessionLoggingPolicy("ssh:staging"))
	if staging.MaxPartBytes != 1024*1024 || staging.MaxParts != 4 || staging.Overridden {
		t.Fatalf("staging policy = %+v", staging)
	}
	if deleted := must(db.DeleteSessionLoggingPolicy("ssh:production")); !deleted {
		t.Fatal("expected policy deletion")
	}
	fallback := must(db.SessionLoggingPolicy("ssh:production"))
	if fallback.MaxParts != 4 || fallback.Overridden {
		t.Fatalf("fallback policy = %+v", fallback)
	}
}

func TestTunnelRoundTrip(t *testing.T) {
	db := openMemory(t)

	created := must(db.SaveTunnel(api.TunnelInput{
		Name: "DB", Target: "web", Type: api.ForwardLocal,
		BindPort: 5432, TargetHost: "localhost", TargetPort: 5432,
	}))
	if created.Name != "DB" || created.Target != "web" || created.Type != api.ForwardLocal ||
		created.BindPort != 5432 || created.TargetHost != "localhost" ||
		created.TargetPort == nil || *created.TargetPort != 5432 {
		t.Fatalf("created = %+v", created)
	}

	updated := must(db.SaveTunnel(api.TunnelInput{
		ID: created.ID, Target: "web", Type: api.ForwardDynamic, BindPort: 1080,
	}))
	if updated.ID != created.ID || updated.Name != "" || updated.Type != api.ForwardDynamic ||
		updated.BindPort != 1080 || updated.TargetHost != "" || updated.TargetPort != nil {
		t.Fatalf("updated = %+v", updated)
	}
	if tunnels := must(db.ListTunnels()); len(tunnels) != 1 {
		t.Fatalf("tunnels = %+v", tunnels)
	}

	if deleted := must(db.DeleteTunnel(created.ID)); !deleted {
		t.Fatal("expected tunnel deletion")
	}
	if tunnels := must(db.ListTunnels()); len(tunnels) != 0 {
		t.Fatalf("tunnels = %+v", tunnels)
	}
}

func TestTunnelRejectsMissingTarget(t *testing.T) {
	db := openMemory(t)
	_, err := db.SaveTunnel(api.TunnelInput{Target: "web", Type: api.ForwardLocal, BindPort: 8080})
	mustErrContain(t, err, "targetHost")
}

func TestTunnelOwnedSSHProfile(t *testing.T) {
	db := openMemory(t)
	port := 2222
	yes := true
	options := &api.TunnelSSHOptions{
		User:           "deploy",
		Port:           &port,
		IdentityFiles:  []string{"~/.ssh/work_ed25519"},
		IdentitiesOnly: &yes,
		ProxyJump:      []string{"bastion", "ops@relay.example.com:2200"},
	}
	created := must(db.SaveTunnel(api.TunnelInput{
		Name: "Private database", Target: "db.internal", SSHOptions: options,
		Type: api.ForwardLocal, BindPort: 5432, TargetHost: "localhost", TargetPort: 5432,
	}))
	if !reflect.DeepEqual(created.SSHOptions, options) {
		t.Fatalf("sshOptions = %+v", created.SSHOptions)
	}

	switchedToHost := must(db.SaveTunnel(api.TunnelInput{
		ID: created.ID, Target: "database-config-alias", Type: api.ForwardDynamic, BindPort: 1080,
	}))
	if switchedToHost.SSHOptions != nil {
		t.Fatalf("sshOptions should be cleared, got %+v", switchedToHost.SSHOptions)
	}
}

func TestOpenSSHMetadataStoresWithoutConnectionDetails(t *testing.T) {
	db := openMemory(t)

	organized := must(db.UpdateOpenSSHMetadata("production", api.OpenSSHMetadataPatch{
		DisplayName: api.Some("Production"),
		Group:       api.Some("Work"),
		Color:       api.Some("#3b82f6"),
		KeywordHighlights: api.Some(api.HostKeywordHighlightConfig{
			InheritGlobal: true,
			Rules: []api.KeywordHighlightRule{{
				ID: "host-error", Keyword: "ERROR", Foreground: "#ffffff",
				Background: "#b91c1c", CaseSensitive: false, WholeWord: true,
			}},
		}),
	}))
	connected := must(db.RecordOpenSSHConnection("production"))

	if connected.ProfileID != organized.ProfileID || connected.DisplayName != "Production" ||
		connected.Group != "Work" || connected.Color != "#3b82f6" || connected.ConnectCount != 1 {
		t.Fatalf("connected = %+v", connected)
	}
	if connected.KeywordHighlights == nil || !connected.KeywordHighlights.InheritGlobal ||
		len(connected.KeywordHighlights.Rules) != 1 ||
		connected.KeywordHighlights.Rules[0].Keyword != "ERROR" {
		t.Fatalf("keywordHighlights = %+v", connected.KeywordHighlights)
	}
	if connected.LastConnectedAt == "" {
		t.Fatal("lastConnectedAt missing")
	}
	metadata := must(db.OpenSSHMetadata([]string{"production"}))
	if !reflect.DeepEqual(metadata["production"], connected) {
		t.Fatalf("metadata = %+v", metadata["production"])
	}
}

func TestOpenSSHGroupsAreCaseInsensitive(t *testing.T) {
	db := openMemory(t)

	must(db.UpdateOpenSSHMetadata("one", api.OpenSSHMetadataPatch{
		Group: api.Some("Production"), Color: api.Some("#ef4444"),
	}))
	grouped := must(db.UpdateOpenSSHMetadata("two", api.OpenSSHMetadataPatch{
		Group: api.Some("production"),
	}))
	cleared := must(db.UpdateOpenSSHMetadata("one", api.OpenSSHMetadataPatch{
		Group: api.Null[string](), Color: api.Null[string](),
	}))

	// One group, not two — but the latest spelling wins, so renaming a
	// sidebar folder to fix its capitalization actually takes effect.
	if grouped.Group != "production" {
		t.Fatalf("grouped.Group = %q", grouped.Group)
	}
	if cleared.Group != "" || cleared.Color != "" {
		t.Fatalf("cleared = %+v", cleared)
	}
}

func TestCaseOnlyGroupRenameAppliesToEveryHost(t *testing.T) {
	db := openMemory(t)

	must(db.UpdateOpenSSHMetadata("one", api.OpenSSHMetadataPatch{Group: api.Some("prod")}))
	must(db.UpdateOpenSSHMetadata("two", api.OpenSSHMetadataPatch{Group: api.Some("prod")}))
	must(db.UpdateOpenSSHMetadata("one", api.OpenSSHMetadataPatch{Group: api.Some("Prod")}))

	metadata := must(db.OpenSSHMetadata([]string{"one", "two"}))
	if metadata["one"].Group != "Prod" || metadata["two"].Group != "Prod" {
		t.Fatalf("metadata = %+v", metadata)
	}
}

func TestRenameOpenSSHAliasPreservesProfileID(t *testing.T) {
	db := openMemory(t)
	before := must(db.UpdateOpenSSHMetadata("old-alias", api.OpenSSHMetadataPatch{Group: api.Some("Work")}))
	must(db.RecordOpenSSHConnection("old-alias"))
	must(db.SaveSessionLoggingPolicy("ssh:old-alias", api.SessionLoggingPolicyInput{
		Enabled: true, CaptureInput: false, MaxPartBytes: 2 * 1024 * 1024, MaxParts: 3,
	}))
	if err := db.RenameOpenSSHAlias("old-alias", "new-alias"); err != nil {
		t.Fatal(err)
	}

	if old := must(db.OpenSSHMetadata([]string{"old-alias"})); len(old) != 0 {
		t.Fatalf("old alias metadata = %+v", old)
	}
	renamed := must(db.OpenSSHMetadata([]string{"new-alias"}))["new-alias"]
	if renamed.ProfileID != before.ProfileID || renamed.Group != "Work" || renamed.ConnectCount != 1 {
		t.Fatalf("renamed = %+v", renamed)
	}
	if policy := must(db.SessionLoggingPolicy("ssh:old-alias")); policy.Overridden {
		t.Fatal("old policy still overridden")
	}
	moved := must(db.SessionLoggingPolicy("ssh:new-alias"))
	if !moved.Enabled || moved.MaxPartBytes != 2*1024*1024 || moved.MaxParts != 3 || !moved.Overridden {
		t.Fatalf("moved policy = %+v", moved)
	}
}

func TestReorderManagedHostsAcrossSources(t *testing.T) {
	db := openMemory(t)
	saved := must(db.SaveSavedHostProfile(api.SavedHostProfileInput{
		Name:    "Core router",
		Profile: api.SavedHostSessionProfile{"kind": "telnet", "host": "router.example.test", "port": 23},
	}))

	if err := db.ReorderManagedHosts([]api.ManagedHostRef{
		{Kind: "ssh", Alias: "gamma"},
		{Kind: "profile", ID: saved.ID},
		{Kind: "ssh", Alias: "alpha"},
	}); err != nil {
		t.Fatal(err)
	}

	metadata := must(db.OpenSSHMetadata([]string{"alpha", "gamma"}))
	if alpha := metadata["alpha"]; alpha.SortOrder == nil || *alpha.SortOrder != 2 {
		t.Fatalf("alpha = %+v", alpha)
	}
	if gamma := metadata["gamma"]; gamma.SortOrder == nil || *gamma.SortOrder != 0 {
		t.Fatalf("gamma = %+v", gamma)
	}
	profile := must(db.SavedHostProfile(saved.ID))
	if profile.Metadata.SortOrder == nil || *profile.Metadata.SortOrder != 1 {
		t.Fatalf("saved sortOrder = %+v", profile.Metadata.SortOrder)
	}

	mustErrContain(t, db.ReorderManagedHosts([]api.ManagedHostRef{
		{Kind: "ssh", Alias: "alpha"},
		{Kind: "ssh", Alias: "alpha"},
	}), "duplicate")
	mustErrContain(t, db.ReorderManagedHosts([]api.ManagedHostRef{
		{Kind: "profile", ID: "missing"},
	}), "not found")
}

func TestSavedHostRoundTrip(t *testing.T) {
	db := openMemory(t)

	created := must(db.SaveSavedHostProfile(api.SavedHostProfileInput{
		Name: "Rack console",
		Profile: api.SavedHostSessionProfile{
			"kind":        "serial",
			"path":        "/dev/ttyUSB0",
			"baudRate":    115200,
			"dataBits":    8,
			"stopBits":    1,
			"parity":      "none",
			"flowControl": "hardware",
		},
	}))
	organized := must(db.UpdateSavedHostMetadata(created.ID, api.OpenSSHMetadataPatch{
		DisplayName: api.Some("Core rack console"),
		Group:       api.Some("Lab"),
		Color:       api.Some("#3b82f6"),
	}))
	if err := db.RecordSavedHostConnection(created.ID); err != nil {
		t.Fatal(err)
	}

	if organized.ID != created.ID || organized.Kind != "serial" || organized.Name != "Core rack console" {
		t.Fatalf("organized = %+v", organized)
	}
	if organized.Profile["kind"] != "serial" || organized.Profile["profileId"] != created.ID ||
		organized.Profile["path"] != "/dev/ttyUSB0" ||
		organized.Profile["baudRate"] != float64(115200) ||
		organized.Profile["flowControl"] != "hardware" {
		t.Fatalf("organized.Profile = %+v", organized.Profile)
	}
	if organized.Metadata.Group != "Lab" || organized.Metadata.Color != "#3b82f6" {
		t.Fatalf("organized.Metadata = %+v", organized.Metadata)
	}
	if profile := must(db.SavedHostProfile(created.ID)); profile.Metadata.ConnectCount != 1 {
		t.Fatalf("connectCount = %d", profile.Metadata.ConnectCount)
	}

	updated := must(db.SaveSavedHostProfile(api.SavedHostProfileInput{
		ID:   created.ID,
		Name: "Console server",
		Profile: api.SavedHostSessionProfile{
			"kind": "telnet",
			"host": "console.example.test",
			"port": 2323,
		},
	}))
	if updated.ID != created.ID || updated.Kind != "telnet" || updated.Name != "Console server" {
		t.Fatalf("updated = %+v", updated)
	}
	if updated.Profile["kind"] != "telnet" || updated.Profile["profileId"] != created.ID ||
		updated.Profile["host"] != "console.example.test" || updated.Profile["port"] != float64(2323) {
		t.Fatalf("updated.Profile = %+v", updated.Profile)
	}
	if updated.Metadata.Group != "Lab" || updated.Metadata.Color != "#3b82f6" ||
		updated.Metadata.ConnectCount != 1 {
		t.Fatalf("updated.Metadata = %+v", updated.Metadata)
	}
	listed := must(db.ListSavedHostProfiles())
	if len(listed) != 1 || !reflect.DeepEqual(listed[0], updated) {
		t.Fatalf("listed = %+v", listed)
	}
	must(db.SaveSessionLoggingPolicy("profile:"+created.ID, api.SessionLoggingPolicyInput{
		Enabled: true, CaptureInput: false, MaxPartBytes: 1024 * 1024, MaxParts: 2,
	}))
	if deleted := must(db.DeleteSavedHostProfile(created.ID)); !deleted {
		t.Fatal("expected saved host deletion")
	}
	if listed := must(db.ListSavedHostProfiles()); len(listed) != 0 {
		t.Fatalf("listed = %+v", listed)
	}
	if policy := must(db.SessionLoggingPolicy("profile:" + created.ID)); policy.Overridden {
		t.Fatal("policy override survived host deletion")
	}
}

func TestSavedHostRejectsSecrets(t *testing.T) {
	db := openMemory(t)
	_, err := db.SaveSavedHostProfile(api.SavedHostProfileInput{
		Name: "Unsafe",
		Profile: api.SavedHostSessionProfile{
			"kind":     "telnet",
			"host":     "router.example.test",
			"port":     23,
			"password": "do-not-save",
		},
	})
	mustErrContain(t, err, "OS credential store")
}

func TestCredentialRefWithNativeProfile(t *testing.T) {
	db := openMemory(t)
	credential := must(db.UpsertCredentialRef(persist.CredentialRefInput{
		Provider: "os-keychain",
		Service:  "muxus/ssh",
		Account:  "alice@example.com",
		Label:    "Production SSH",
	}))
	if _, err := db.CreateNativeConnection(persist.NativeConnectionInput{
		Kind: "ssh",
		Name: "Production",
		Config: map[string]any{
			"host":         "example.com",
			"identityFile": "/home/alice/.ssh/id_ed25519",
		},
		CredentialRefID: credential.ID,
	}); err != nil {
		t.Fatalf("createNativeConnection: %v", err)
	}
}

func TestRejectsSecretsAnywhere(t *testing.T) {
	db := openMemory(t)
	mustErrContain(t,
		persist.AssertSecretFree(map[string]any{"nested": map[string]any{"password": "hunter2"}}, ""),
		"OS credential store")
	mustErrContain(t,
		persist.AssertSecretFree(map[string]any{"auth": map[string]any{"privateKeyPem": "-----BEGIN PRIVATE KEY-----"}}, ""),
		"OS credential store")
	mustErrContain(t,
		persist.AssertSecretFree(map[string]any{"auth": map[string]any{"api_token_value": "secret"}}, ""),
		"OS credential store")
	if err := persist.AssertSecretFree(map[string]any{"auth": map[string]any{
		"privateKeyPath":          "/home/alice/.ssh/id_ed25519",
		"passwordCredentialRefId": "credential-1",
	}}, ""); err != nil {
		t.Fatalf("reference-only keys rejected: %v", err)
	}
	_, err := db.CreateNativeConnection(persist.NativeConnectionInput{
		Kind:   "ssh",
		Name:   "Unsafe",
		Config: map[string]any{"auth": map[string]any{"passphrase": "secret"}},
	})
	mustErrContain(t, err, "OS credential store")
	_, err = db.SaveWorkspace(persist.WorkspaceInput{
		Name:   "Unsafe",
		Layout: map[string]any{"pane": map[string]any{"token": "secret"}},
	})
	mustErrContain(t, err, "OS credential store")
}

func TestWorkspaceRoundTrip(t *testing.T) {
	db := openMemory(t)
	saved := must(db.SaveWorkspace(persist.WorkspaceInput{
		Name: "Daily work",
		MultiExecGroups: []api.WorkspaceMultiExecGroup{
			{ID: "prod", Name: "Production", TabIDs: []string{"tab-a", "tab-b"}},
		},
		Layout: map[string]any{
			"version": 1,
			"root": map[string]any{
				"type":      "split",
				"direction": "horizontal",
				"ratio":     0.5,
				"children": []any{
					map[string]any{"type": "terminal", "profileRef": "profile-a", "cwdHint": "/srv/app"},
					map[string]any{"type": "sftp", "profileRef": "profile-a", "path": "/var/log"},
				},
			},
		},
	}))

	roundTripped := must(db.Workspace(saved.ID))
	if roundTripped == nil || !reflect.DeepEqual(*roundTripped, saved) {
		t.Fatalf("workspace = %+v, saved = %+v", roundTripped, saved)
	}
	if saved.IsStartup {
		t.Fatal("new workspace marked startup")
	}
	if !reflect.DeepEqual(saved.MultiExecGroups, []api.WorkspaceMultiExecGroup{
		{ID: "prod", Name: "Production", TabIDs: []string{"tab-a", "tab-b"}},
	}) {
		t.Fatalf("multiExecGroups = %+v", saved.MultiExecGroups)
	}
}

func TestWorkspaceStartupLifecycle(t *testing.T) {
	db := openMemory(t)
	first := must(db.SaveWorkspace(persist.WorkspaceInput{
		Name: "First", Layout: map[string]any{"version": 1, "root": nil},
	}))
	second := must(db.SaveWorkspace(persist.WorkspaceInput{
		Name: "Second", Layout: map[string]any{"version": 1, "root": nil},
	}))

	renamed := must(db.RenameWorkspace(first.ID, "Daily"))
	if renamed == nil || renamed.Name != "Daily" {
		t.Fatalf("renamed = %+v", renamed)
	}
	opened := must(db.OpenWorkspace(first.ID))
	if opened == nil || opened.LastOpenedAt == "" {
		t.Fatalf("opened = %+v", opened)
	}
	firstStartup := must(db.SetStartupWorkspace(&first.ID))
	if firstStartup == nil || firstStartup.ID != first.ID || !firstStartup.IsStartup {
		t.Fatalf("firstStartup = %+v", firstStartup)
	}
	secondStartup := must(db.SetStartupWorkspace(&second.ID))
	if secondStartup == nil || secondStartup.ID != second.ID || !secondStartup.IsStartup {
		t.Fatalf("secondStartup = %+v", secondStartup)
	}
	if refreshed := must(db.Workspace(first.ID)); refreshed.IsStartup {
		t.Fatal("first workspace still marked startup")
	}
	if startup := must(db.StartupWorkspace()); startup == nil || startup.ID != second.ID {
		t.Fatalf("startup = %+v", startup)
	}
	startupCount := 0
	for _, summary := range must(db.ListWorkspaceSummaries()) {
		if summary.IsStartup {
			startupCount++
		}
	}
	if startupCount != 1 {
		t.Fatalf("startupCount = %d", startupCount)
	}
	if cleared := must(db.SetStartupWorkspace(nil)); cleared != nil {
		t.Fatalf("cleared = %+v", cleared)
	}
	if startup := must(db.StartupWorkspace()); startup != nil {
		t.Fatalf("startup = %+v", startup)
	}
}
