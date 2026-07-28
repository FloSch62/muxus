package ws

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/persist"
)

func recorderFixture(t *testing.T) (*persist.DB, *history.Store) {
	t.Helper()
	db, err := persist.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	settings, err := db.SessionHistorySettings()
	if err != nil {
		t.Fatal(err)
	}
	store, err := history.Open(history.Options{Root: t.TempDir(), Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db, store
}

func TestRecorderIsOptInAndHonoursPrivacyControls(t *testing.T) {
	db, store := recorderFixture(t)
	if _, err := db.SaveSessionLoggingPolicy("ssh:production", api.SessionLoggingPolicyInput{
		Enabled: true, CaptureInput: false, MaxPartBytes: 5 * 1024 * 1024, MaxParts: 10,
	}); err != nil {
		t.Fatal(err)
	}
	recorder := NewSessionRecorder(
		db,
		store,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		api.SessionProfile{SSH: &api.SSHProfile{Kind: "ssh", Target: "production"}},
		"Production",
	)

	recorder.Input([]byte("secret-token"))
	recorder.Output([]byte("\x1b[31mvisible error\x1b[0m\r\n"))
	paused := true
	recorder.SetState(nil, &paused, nil)
	recorder.Output([]byte("not retained"))
	paused = false
	captureInput := true
	recorder.SetState(nil, &paused, &captureInput)
	recorder.Input([]byte("safe-command\n"))
	recorder.End("completed")

	state := recorder.State()
	if state.SessionID == "" || state.Enabled || state.Paused || !state.CaptureInput {
		t.Fatalf("final state = %+v", state)
	}
	detail, err := store.SessionLog(state.SessionID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if detail == nil || detail.Status != "completed" || !detail.CaptureInput {
		t.Fatalf("detail = %+v", detail)
	}
	var transcript strings.Builder
	for _, event := range detail.Events {
		transcript.WriteString(event.Text)
	}
	text := transcript.String()
	for _, wanted := range []string{
		"visible error\n",
		"Session logging paused.",
		"Session logging resumed.",
		"safe-command\n",
	} {
		if !strings.Contains(text, wanted) {
			t.Fatalf("transcript missing %q: %q", wanted, text)
		}
	}
	for _, forbidden := range []string{"secret-token", "not retained"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("transcript contains %q: %q", forbidden, text)
		}
	}
}

func TestRecorderCanStartAndStopMultipleHistorySessions(t *testing.T) {
	db, store := recorderFixture(t)
	recorder := NewSessionRecorder(
		db,
		store,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		api.SessionProfile{Local: &api.LocalProfile{Kind: "local", Shell: "/bin/sh"}},
		"Local shell",
	)
	recorder.Output([]byte("before logging\r\n"))
	enabled := true
	first := recorder.SetState(&enabled, nil, nil).SessionID
	recorder.Output([]byte("first recording\r\n"))
	enabled = false
	recorder.SetState(&enabled, nil, nil)
	recorder.Output([]byte("between recordings\r\n"))
	enabled = true
	second := recorder.SetState(&enabled, nil, nil).SessionID
	recorder.Output([]byte("second recording\r\n"))
	recorder.End("completed")

	if first == "" || second == "" || first == second {
		t.Fatalf("session IDs = %q, %q", first, second)
	}
	firstDetail, err := store.SessionLog(first, nil)
	if err != nil {
		t.Fatal(err)
	}
	secondDetail, err := store.SessionLog(second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if firstDetail == nil || secondDetail == nil {
		t.Fatalf("missing details: first=%+v second=%+v", firstDetail, secondDetail)
	}
	join := func(detail *api.SessionLogDetail) string {
		var result strings.Builder
		for _, event := range detail.Events {
			result.WriteString(event.Text)
		}
		return result.String()
	}
	firstText, secondText := join(firstDetail), join(secondDetail)
	if !strings.Contains(firstText, "first recording\n") ||
		!strings.Contains(firstText, "Session logging stopped.") ||
		strings.Contains(firstText, "before logging") ||
		strings.Contains(firstText, "between recordings") {
		t.Fatalf("first transcript = %q", firstText)
	}
	if !strings.Contains(secondText, "second recording\n") ||
		strings.Contains(secondText, "between recordings") {
		t.Fatalf("second transcript = %q", secondText)
	}
}

func TestTerminalTextNormalizerHandlesSplitControlSequencesAndRedraws(t *testing.T) {
	normalizer := NewTerminalTextNormalizer(4)
	var chunks strings.Builder
	for _, chunk := range []string{
		"one\r\n\x1b[31",
		"mred\x1b[0m \x1b]0;secret title",
		"\x07two\r\nDownloading 10%\rDownloading 100%\r\n",
	} {
		chunks.WriteString(normalizer.Write([]byte(chunk)))
	}
	chunks.WriteString(normalizer.Finish())
	if got := chunks.String(); got != "one\nred two\nDownloading 100%\n" {
		t.Fatalf("normalized text = %q", got)
	}
}
