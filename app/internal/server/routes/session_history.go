package routes

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/server"
)

const transcriptPreviewEvents = 5_000

func configuredHistoryLocation(ctx *server.Context, settings api.SessionHistorySettings) string {
	if ctx.Config.HistoryPath != "" {
		return ctx.Config.HistoryPath
	}
	if settings.StorageLocation != "" {
		return settings.StorageLocation
	}
	if ctx.Config.DatabasePath == ":memory:" {
		return ""
	}
	return filepath.Join(filepath.Dir(ctx.Config.DatabasePath), "history")
}

func parseHistoryQuery(req *http.Request) (history.Query, error) {
	values := req.URL.Query()
	query := history.Query{
		Query:      strings.TrimSpace(values.Get("query")),
		ProfileKey: strings.TrimSpace(values.Get("profileKey")),
		Host:       strings.TrimSpace(values.Get("host")),
		Kind:       values.Get("kind"), StartedAfter: values.Get("startedAfter"),
		StartedBefore: values.Get("startedBefore"), Cursor: values.Get("cursor"),
		Limit: 50,
	}
	if len(query.Query) > 500 || len(query.ProfileKey) > 500 ||
		len(query.Host) > 500 || len(query.Cursor) > 1000 {
		return query, fmt.Errorf("session-history query is too long")
	}
	if query.ProfileKey == "" && values.Has("profileKey") {
		return query, fmt.Errorf("profileKey is required")
	}
	if query.Kind != "" && query.Kind != "ssh" && query.Kind != "local" &&
		query.Kind != "serial" && query.Kind != "telnet" {
		return query, fmt.Errorf("invalid session kind")
	}
	for _, value := range []string{query.StartedAfter, query.StartedBefore} {
		if value != "" {
			if _, err := time.Parse(time.RFC3339, value); err != nil {
				return query, fmt.Errorf("invalid ISO datetime")
			}
		}
	}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return query, fmt.Errorf("limit must be between 1 and 100")
		}
		query.Limit = limit
	}
	return query, nil
}

func parsePolicyKey(req *http.Request) (string, error) {
	key := strings.TrimSpace(req.URL.Query().Get("profileKey"))
	if key == "" || len(key) > 500 {
		return "", fmt.Errorf("profileKey is required")
	}
	return key, nil
}

func RegisterSessionHistoryRoutes(r chi.Router, ctx *server.Context) {
	r.Get("/api/session-history", func(w http.ResponseWriter, req *http.Request) {
		query, err := parseHistoryQuery(req)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		response, err := ctx.History.SessionHistory(query)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, response)
	})

	r.Get("/api/session-history/storage", func(w http.ResponseWriter, _ *http.Request) {
		settings, err := ctx.Database.SessionHistorySettings()
		if err != nil {
			writeInternalError(w, err)
			return
		}
		status, err := ctx.History.StorageStatus(configuredHistoryLocation(ctx, settings))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, status)
	})
	r.Put("/api/session-history/storage", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input api.SessionHistorySettingsInput
		if err := json.Unmarshal(body, &input); err != nil {
			writeBadRequest(w, "invalid session-history settings")
			return
		}
		settings, err := ctx.Database.SaveSessionHistorySettings(input)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		if err := ctx.History.UpdateSettings(settings); err != nil {
			writeInternalError(w, err)
			return
		}
		status, err := ctx.History.StorageStatus(configuredHistoryLocation(ctx, settings))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, status)
	})

	r.Get("/api/session-history/policy", func(w http.ResponseWriter, req *http.Request) {
		key, err := parsePolicyKey(req)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		policy, err := ctx.Database.SessionLoggingPolicy(key)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, policy)
	})
	r.Put("/api/session-history/policy", func(w http.ResponseWriter, req *http.Request) {
		key, err := parsePolicyKey(req)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input api.SessionLoggingPolicyInput
		if err := json.Unmarshal(body, &input); err != nil {
			writeBadRequest(w, "invalid session logging policy")
			return
		}
		policy, err := ctx.Database.SaveSessionLoggingPolicy(key, input)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		server.WriteJSON(w, http.StatusOK, policy)
	})
	r.Delete("/api/session-history/policy", func(w http.ResponseWriter, req *http.Request) {
		key, err := parsePolicyKey(req)
		if err != nil {
			writeBadRequest(w, err.Error())
			return
		}
		deleted, err := ctx.Database.DeleteSessionLoggingPolicy(key)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, deletedResponse{Deleted: deleted})
	})

	r.Get("/api/session-history/{id}", func(w http.ResponseWriter, req *http.Request) {
		limit := transcriptPreviewEvents
		session, err := ctx.History.SessionLog(chi.URLParam(req, "id"), &limit)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if session == nil {
			writeNotFound(w, "session log not found")
			return
		}
		server.WriteJSON(w, http.StatusOK, session)
	})
	r.Get("/api/session-history/{id}/raw", func(w http.ResponseWriter, req *http.Request) {
		zero := 0
		session, err := ctx.History.SessionLog(chi.URLParam(req, "id"), &zero)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		events, err := ctx.History.RawSessionLogEvents(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if session == nil || events == nil {
			writeNotFound(w, "session log not found")
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set(
			"Content-Disposition",
			`attachment; filename="`+exportSlug(session.Title)+`.muxlog"`,
		)
		encoder := json.NewEncoder(w)
		for _, event := range events {
			_ = encoder.Encode(map[string]any{
				"sequence": event.Sequence, "recordedAt": event.RecordedAt,
				"elapsedMs": event.ElapsedMs, "direction": event.Direction,
				"encoding": "base64", "data": base64.StdEncoding.EncodeToString(event.Raw),
			})
		}
	})
	r.Get("/api/session-history/{id}/clean", func(w http.ResponseWriter, req *http.Request) {
		session, err := ctx.History.SessionLog(chi.URLParam(req, "id"), nil)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if session == nil {
			writeNotFound(w, "session log not found")
			return
		}
		var transcript strings.Builder
		for _, event := range session.Events {
			transcript.WriteString(event.Text)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set(
			"Content-Disposition",
			`attachment; filename="`+exportSlug(session.Title)+`-clean.txt"`,
		)
		_, _ = w.Write([]byte(transcript.String()))
	})
	r.Get("/api/session-history/{id}/replay.html", func(w http.ResponseWriter, req *http.Request) {
		session, err := ctx.History.SessionLog(chi.URLParam(req, "id"), nil)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if session == nil {
			writeNotFound(w, "session log not found")
			return
		}
		sendReplay(w, session)
	})
	r.Put("/api/session-history/{id}/pin", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readJSONBody(w, req, defaultBodyLimit)
		if !ok {
			return
		}
		var input struct {
			Pinned *bool `json:"pinned"`
		}
		if json.Unmarshal(body, &input) != nil || input.Pinned == nil {
			writeBadRequest(w, "pinned is required")
			return
		}
		updated, err := ctx.History.SetPinned(chi.URLParam(req, "id"), *input.Pinned)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, map[string]bool{"updated": updated})
	})
	r.Delete("/api/session-history/{id}", func(w http.ResponseWriter, req *http.Request) {
		deleted, err := ctx.History.DeleteSession(chi.URLParam(req, "id"))
		if err != nil {
			writeInternalError(w, err)
			return
		}
		server.WriteJSON(w, http.StatusOK, deletedResponse{Deleted: deleted})
	})
}

var slugNonAlpha = regexp.MustCompile(`[^a-z0-9]+`)

func exportSlug(title string) string {
	value := strings.Trim(slugNonAlpha.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(value) > 48 {
		value = value[:48]
	}
	if value == "" {
		return "session"
	}
	return value
}

func sendReplay(w http.ResponseWriter, session *api.SessionLogDetail) {
	type replayEvent struct {
		Time      int64  `json:"t"`
		Direction string `json:"d"`
		Text      string `json:"x"`
	}
	events := make([]replayEvent, len(session.Events))
	for index, event := range session.Events {
		events[index] = replayEvent{
			Time: event.ElapsedMs, Direction: event.Direction, Text: event.Text,
		}
	}
	raw, _ := json.Marshal(events)
	eventsJSON := strings.NewReplacer(
		"<", `\u003c`, "\u2028", `\u2028`, "\u2029", `\u2029`,
	).Replace(string(raw))
	title := html.EscapeString(session.Title)
	host := html.EscapeString(session.Host)
	started := html.EscapeString(session.StartedAt)
	page := `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>` + title + ` — Muxus replay</title><style>` +
		`:root{color-scheme:dark;background:#0c1117;color:#d7dee7;font:14px system-ui,sans-serif}` +
		`*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column}` +
		`header{padding:14px 18px;background:#121a23;border-bottom:1px solid #293442}` +
		`h1{font-size:16px;margin:0 0 4px}.meta{color:#8fa0b3;font-size:12px}` +
		`.controls{display:flex;align-items:center;gap:10px;padding:10px 18px;background:#0f171f}` +
		`button,select{color:inherit;background:#1b2733;border:1px solid #3a4959;border-radius:5px;padding:6px 10px}` +
		`input{flex:1}.time{min-width:110px;text-align:right}pre{flex:1;margin:0;padding:18px;overflow:auto;white-space:pre-wrap;font:13px/1.5 monospace}` +
		`.input{color:#8ec7ff}.system{color:#8391a2;font-style:italic}</style></head><body>` +
		`<header><h1>` + title + `</h1><div class="meta">` + host + ` · started ` + started +
		` · ` + strconv.FormatInt(session.EventCount, 10) + ` retained events</div></header>` +
		`<div class="controls"><button id="play">Play</button><button id="restart">Restart</button>` +
		`<label>Speed <select id="speed"><option value=".5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="5">5×</option><option value="20">20×</option></select></label>` +
		`<input id="seek" type="range" min="0" max="0" value="0"><span class="time" id="time">00:00 / 00:00</span></div><pre id="screen"></pre>` +
		`<script>const events=` + eventsJSON + `,duration=events.length?events.at(-1).t:0;` +
		`const screen=document.querySelector('#screen'),play=document.querySelector('#play'),seek=document.querySelector('#seek'),clock=document.querySelector('#time'),speed=document.querySelector('#speed');seek.max=duration;let position=0,index=0,running=false,last=0;const fmt=ms=>{const s=Math.floor(ms/1000),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};function append(e){const x=document.createElement('span');x.className=e.d;x.textContent=e.x;screen.append(x)}function render(to){screen.textContent='';index=0;while(index<events.length&&events[index].t<=to)append(events[index++]);position=to;seek.value=to;clock.textContent=fmt(to)+' / '+fmt(duration)}function frame(now){if(!running)return;position=Math.min(duration,position+(now-last)*Number(speed.value));last=now;while(index<events.length&&events[index].t<=position)append(events[index++]);seek.value=position;clock.textContent=fmt(position)+' / '+fmt(duration);if(position>=duration){running=false;play.textContent='Play';return}requestAnimationFrame(frame)}play.onclick=()=>{running=!running;play.textContent=running?'Pause':'Play';last=performance.now();if(running)requestAnimationFrame(frame)};restart.onclick=()=>{running=false;play.textContent='Play';render(0)};seek.oninput=()=>render(Number(seek.value));render(0)</script></body></html>`
	w.Header().Set("Content-Type", "text/html")
	w.Header().Set(
		"Content-Disposition",
		`attachment; filename="`+exportSlug(session.Title)+`-replay.html"`,
	)
	_, _ = w.Write([]byte(page))
}
