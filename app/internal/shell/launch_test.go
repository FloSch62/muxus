package shell

import (
	"encoding/json"
	"testing"
)

func TestParseWindowLaunchAcceptsSessionAndSFTP(t *testing.T) {
	session, err := parseWindowLaunch([]byte(`{
		"kind":"session",
		"title":"Router",
		"color":"#123456",
		"profile":{"kind":"ssh","target":"edge"}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if session.Kind != "session" || session.Title != "Router" {
		t.Fatalf("session = %+v", session)
	}
	var profile map[string]any
	if err := json.Unmarshal(session.Profile, &profile); err != nil {
		t.Fatal(err)
	}
	if profile["target"] != "edge" {
		t.Fatalf("profile = %+v", profile)
	}

	sftp, err := parseWindowLaunch([]byte(`{
		"kind":"sftp","connId":"ssh-1","title":"Files","path":"/srv"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if sftp.ConnID != "ssh-1" || sftp.Path != "/srv" {
		t.Fatalf("sftp = %+v", sftp)
	}
}

func TestParseWindowLaunchRejectsMalformedPayloads(t *testing.T) {
	for _, payload := range []string{
		``,
		`{"kind":"unknown","title":"x"}`,
		`{"kind":"session","title":"Missing profile"}`,
		`{"kind":"session","title":"Bad","profile":{"kind":"ssh","target":""}}`,
		`{"kind":"sftp","connId":"","title":"Files"}`,
	} {
		if _, err := parseWindowLaunch([]byte(payload)); err == nil {
			t.Fatalf("payload accepted: %s", payload)
		}
	}
}
