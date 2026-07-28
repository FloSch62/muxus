package ws

import (
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/history"
	"github.com/FloSch62/muxus/app/internal/persist"
)

const (
	recorderFlushInterval = 250 * time.Millisecond
	maxBufferedEventBytes = 256 * 1024
)

type SessionRecorder struct {
	store  *history.Store
	log    *slog.Logger
	policy api.SessionLoggingPolicy
	input  history.SessionLogCreateInput

	mu               sync.Mutex
	state            LoggingState
	startedAt        time.Time
	inputNormalizer  *TerminalTextNormalizer
	outputNormalizer *TerminalTextNormalizer
	sequence         int64
	terminalEnded    bool
	pending          []history.HistoryEvent
	timer            *time.Timer
	stateListener    func(LoggingState)
	unsubscribe      func()
}

func NewSessionRecorder(
	db *persist.DB,
	store *history.Store,
	log *slog.Logger,
	profile api.SessionProfile,
	title string,
) Recorder {
	profileKey, host := sessionProfileIdentity(profile)
	policy, err := db.SessionLoggingPolicy(profileKey)
	if err != nil {
		if log != nil {
			log.Warn("could not resolve session logging policy", "error", err)
		}
		return &NoopRecorder{}
	}
	kind := profile.Kind()
	recorder := &SessionRecorder{
		store: store, log: log, policy: policy,
		input: history.SessionLogCreateInput{
			ProfileKey: profileKey, Title: strings.TrimSpace(title),
			Kind: kind, Host: host,
		},
		state:            LoggingState{CaptureInput: policy.CaptureInput},
		inputNormalizer:  NewTerminalTextNormalizer(0),
		outputNormalizer: NewTerminalTextNormalizer(4),
	}
	if recorder.input.Title == "" {
		recorder.input.Title = host
	}
	if policy.Enabled {
		recorder.mu.Lock()
		recorder.startLoggingLocked()
		recorder.mu.Unlock()
	}
	return recorder
}

func sessionProfileIdentity(profile api.SessionProfile) (profileKey, host string) {
	switch {
	case profile.SSH != nil:
		return "ssh:" + profile.SSH.Target, profile.SSH.Target
	case profile.Telnet != nil:
		host = profile.Telnet.Host + ":" + strconvItoa(profile.Telnet.Port)
		if profile.Telnet.ProfileID != "" {
			return "profile:" + profile.Telnet.ProfileID, host
		}
		return "telnet:" + host, host
	case profile.Serial != nil:
		if profile.Serial.ProfileID != "" {
			return "profile:" + profile.Serial.ProfileID, profile.Serial.Path
		}
		return "serial:" + profile.Serial.Path, profile.Serial.Path
	case profile.Local != nil:
		host = strings.TrimSpace(profile.Local.Shell)
		if host == "" {
			host = "Local shell"
		}
		return "local", host
	default:
		return "unknown", "Unknown session"
	}
}

func strconvItoa(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [24]byte
	index := len(buf)
	for value > 0 {
		index--
		buf[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[index:])
}

func (r *SessionRecorder) State() LoggingState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

func (r *SessionRecorder) OnStateChange(listener func(LoggingState)) {
	r.mu.Lock()
	r.stateListener = listener
	r.mu.Unlock()
}

func (r *SessionRecorder) Input(data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.state.Enabled || r.state.Paused || r.terminalEnded || !r.state.CaptureInput {
		return
	}
	r.flushOutputSnapshotLocked()
	r.appendLocked("input", data, r.inputNormalizer.Write(data))
}

func (r *SessionRecorder) Output(data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.state.Enabled || r.state.Paused || r.terminalEnded {
		return
	}
	if r.state.CaptureInput {
		r.flushInputSnapshotLocked()
	}
	r.appendLocked("output", data, r.outputNormalizer.Write(data))
}

func (r *SessionRecorder) System(message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.state.Enabled || r.state.Paused || r.terminalEnded {
		return
	}
	r.flushNormalizerSnapshotsLocked(false)
	text := message + "\n"
	r.appendNowLocked("system", []byte(text), text)
}

func (r *SessionRecorder) SetState(enabled, paused, captureInput *bool) LoggingState {
	r.mu.Lock()
	if r.terminalEnded {
		state := r.state
		r.mu.Unlock()
		return state
	}
	if enabled != nil && !*enabled && r.state.Enabled {
		r.finishLoggingLocked("completed", "Session logging stopped.")
		state := r.state
		r.mu.Unlock()
		return state
	}
	if enabled != nil && *enabled && !r.state.Enabled {
		r.startLoggingLocked()
	}
	if !r.state.Enabled {
		state := r.state
		r.mu.Unlock()
		return state
	}
	if paused != nil && *paused != r.state.Paused {
		if *paused {
			r.flushNormalizerSnapshotsLocked(false)
			r.appendNowLocked(
				"system", []byte("Session logging paused.\n"), "Session logging paused.\n",
			)
			r.state.Paused = true
		} else {
			r.state.Paused = false
			r.appendNowLocked(
				"system", []byte("Session logging resumed.\n"), "Session logging resumed.\n",
			)
		}
	}
	if captureInput != nil && *captureInput != r.state.CaptureInput {
		if !*captureInput {
			r.flushInputSnapshotLocked()
		}
		r.state.CaptureInput = *captureInput
		marker := "Input recording suppressed.\n"
		if *captureInput {
			marker = "Input recording enabled.\n"
		}
		r.appendNowLocked("system", []byte(marker), marker)
	}
	sessionID := r.state.SessionID
	currentPaused := r.state.Paused
	currentCapture := r.state.CaptureInput
	state := r.state
	r.mu.Unlock()
	r.store.SetSessionState(sessionID, &currentPaused, &currentCapture)
	return state
}

func (r *SessionRecorder) End(status string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminalEnded {
		return
	}
	r.finishLoggingLocked(status, "Session logging ended ("+status+").")
	r.terminalEnded = true
}

func (r *SessionRecorder) startLoggingLocked() {
	if r.state.Enabled || r.terminalEnded {
		return
	}
	r.startedAt = time.Now().UTC()
	r.inputNormalizer = NewTerminalTextNormalizer(0)
	r.outputNormalizer = NewTerminalTextNormalizer(4)
	r.sequence = 0
	r.pending = nil
	r.state.Enabled = true
	r.state.SessionID = r.store.BeginSession(history.SessionLogCreateInput{
		ProfileKey: r.input.ProfileKey, Title: r.input.Title,
		Kind: r.input.Kind, Host: r.input.Host,
		StartedAt:    r.startedAt.Format(time.RFC3339Nano),
		CaptureInput: r.state.CaptureInput,
	}, history.PartPolicy{
		MaxPartBytes: r.policy.MaxPartBytes, MaxParts: r.policy.MaxParts,
	})
	r.state.Paused = false
	r.state.Warning = ""
	r.unsubscribe = r.store.OnSessionFailure(r.state.SessionID, r.suspend)
	r.appendNowLocked(
		"system", []byte("Session logging started.\n"), "Session logging started.\n",
	)
}

func (r *SessionRecorder) finishLoggingLocked(status, marker string) {
	if !r.state.Enabled || r.state.SessionID == "" {
		return
	}
	r.state.Paused = false
	r.flushNormalizerSnapshotsLocked(true)
	r.appendNowLocked("system", []byte(marker+"\n"), marker+"\n")
	r.flushLocked()
	r.state.Enabled = false
	r.state.Paused = false
	r.store.FinishSession(r.state.SessionID, status, time.Now().UTC().Format(time.RFC3339Nano))
	if r.unsubscribe != nil {
		r.unsubscribe()
		r.unsubscribe = nil
	}
}

func (r *SessionRecorder) appendLocked(direction string, raw []byte, text string) {
	if !r.state.Enabled || r.state.Paused || r.terminalEnded ||
		len(raw) == 0 && text == "" {
		return
	}
	now := time.Now().UTC()
	if len(r.pending) > 0 {
		last := &r.pending[len(r.pending)-1]
		if last.Direction == direction && len(last.Raw)+len(raw) <= maxBufferedEventBytes {
			last.Raw = append(last.Raw, raw...)
			last.Text += text
			if len(raw) >= maxBufferedEventBytes {
				r.flushLocked()
			}
			return
		}
	}
	r.sequence++
	r.pending = append(r.pending, history.HistoryEvent{
		Sequence: r.sequence, RecordedAt: now.Format(time.RFC3339Nano),
		ElapsedMs: now.Sub(r.startedAt).Milliseconds(),
		Direction: direction, Raw: append([]byte(nil), raw...), Text: text,
	})
	if len(raw) >= maxBufferedEventBytes {
		r.flushLocked()
		return
	}
	if r.timer == nil {
		r.timer = time.AfterFunc(recorderFlushInterval, func() {
			r.mu.Lock()
			r.timer = nil
			r.flushLocked()
			r.mu.Unlock()
		})
	}
}

func (r *SessionRecorder) appendNowLocked(direction string, raw []byte, text string) {
	if !r.state.Enabled || r.state.Paused || r.terminalEnded ||
		len(raw) == 0 && text == "" {
		return
	}
	now := time.Now().UTC()
	r.sequence++
	r.persistLocked([]history.HistoryEvent{{
		Sequence: r.sequence, RecordedAt: now.Format(time.RFC3339Nano),
		ElapsedMs: max(0, now.Sub(r.startedAt).Milliseconds()),
		Direction: direction, Raw: append([]byte(nil), raw...), Text: text,
	}})
}

func (r *SessionRecorder) flushLocked() {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	pending := r.pending
	r.pending = nil
	if len(pending) > 0 {
		r.persistLocked(pending)
	}
}

func (r *SessionRecorder) persistLocked(events []history.HistoryEvent) {
	if !r.store.Append(r.state.SessionID, events, history.PartPolicy{
		MaxPartBytes: r.policy.MaxPartBytes, MaxParts: r.policy.MaxParts,
	}) {
		go r.suspend("Session logging suspended: the history write queue is full.")
	}
}

func (r *SessionRecorder) flushNormalizerSnapshotsLocked(final bool) {
	r.flushLocked()
	var input, output string
	if final {
		input = r.inputNormalizer.Finish()
		output = r.outputNormalizer.Finish()
	} else {
		input = r.inputNormalizer.Drain()
		output = r.outputNormalizer.Drain()
	}
	if input != "" {
		r.appendNowLocked("input", nil, input)
	}
	if output != "" {
		r.appendNowLocked("output", nil, output)
	}
}

func (r *SessionRecorder) flushInputSnapshotLocked() {
	r.flushLocked()
	if text := r.inputNormalizer.Drain(); text != "" {
		r.appendNowLocked("input", nil, text)
	}
}

func (r *SessionRecorder) flushOutputSnapshotLocked() {
	r.flushLocked()
	if text := r.outputNormalizer.Drain(); text != "" {
		r.appendNowLocked("output", nil, text)
	}
}

func (r *SessionRecorder) suspend(message string) {
	r.mu.Lock()
	if !r.state.Enabled || r.terminalEnded {
		r.mu.Unlock()
		return
	}
	r.state.Enabled = false
	r.state.Paused = false
	r.state.Warning = message
	r.pending = nil
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	sessionID := r.state.SessionID
	listener := r.stateListener
	state := r.state
	if r.unsubscribe != nil {
		r.unsubscribe()
		r.unsubscribe = nil
	}
	r.mu.Unlock()
	r.store.FinishSession(sessionID, "failed", time.Now().UTC().Format(time.RFC3339Nano))
	if r.log != nil {
		r.log.Warn("terminal session logging suspended", "sessionId", sessionID, "reason", message)
	}
	if listener != nil {
		listener(state)
	}
}

// TerminalTextNormalizer is the small streaming screen reconciler used for
// searchable transcripts. Raw bytes are stored separately and untouched.
type TerminalTextNormalizer struct {
	editableRows int
	state        string
	csi          strings.Builder
	rows         [][]rune
	cursorRow    int
	cursorCol    int
	savedRow     int
	savedCol     int
	committed    strings.Builder
	utf8Carry    []byte
}

func NewTerminalTextNormalizer(editableRows int) *TerminalTextNormalizer {
	return &TerminalTextNormalizer{
		editableRows: editableRows, state: "text", rows: [][]rune{{}},
	}
}

func (n *TerminalTextNormalizer) Write(data []byte) string {
	n.processBytes(data, false)
	n.commitReadyRows()
	return n.takeCommitted()
}

func (n *TerminalTextNormalizer) Drain() string {
	n.commitAllRows()
	n.resetRows()
	return n.takeCommitted()
}

func (n *TerminalTextNormalizer) Finish() string {
	n.processBytes(nil, true)
	return n.Drain()
}

func (n *TerminalTextNormalizer) processBytes(data []byte, final bool) {
	buffer := append(append([]byte(nil), n.utf8Carry...), data...)
	n.utf8Carry = nil
	for len(buffer) > 0 {
		if !utf8.FullRune(buffer) && !final {
			n.utf8Carry = append(n.utf8Carry, buffer...)
			break
		}
		r, size := utf8.DecodeRune(buffer)
		if r == utf8.RuneError && size == 1 && !final && len(buffer) < utf8.UTFMax {
			n.utf8Carry = append(n.utf8Carry, buffer...)
			break
		}
		n.processRune(r)
		buffer = buffer[size:]
	}
	if final && len(n.utf8Carry) > 0 {
		n.processRune(utf8.RuneError)
		n.utf8Carry = nil
	}
}

func (n *TerminalTextNormalizer) processRune(char rune) {
	switch n.state {
	case "text":
		switch char {
		case 0x1b:
			n.state = "escape"
		case '\r':
			n.cursorCol = 0
		case '\n':
			n.cursorRow++
			n.ensureRow(n.cursorRow)
		case '\b':
			n.cursorCol = max(0, n.cursorCol-1)
		case '\t':
			spaces := 8 - n.cursorCol%8
			for range spaces {
				n.put(' ')
			}
		default:
			if char >= 0x20 && char != 0x7f {
				n.put(char)
			}
		}
	case "escape":
		switch {
		case char == '[':
			n.csi.Reset()
			n.state = "csi"
		case char == ']' || char == 'P' || char == '_' || char == '^':
			n.state = "string"
		case char >= 0x20 && char <= 0x2f:
			n.state = "escape-intermediate"
		default:
			n.handleEscape(char)
			n.state = "text"
		}
	case "escape-intermediate":
		if char >= 0x30 && char <= 0x7e {
			n.state = "text"
		}
	case "csi":
		if char >= 0x40 && char <= 0x7e {
			n.handleCSI(char)
			n.csi.Reset()
			n.state = "text"
		} else {
			n.csi.WriteRune(char)
		}
	case "string":
		if char == 0x07 {
			n.state = "text"
		} else if char == 0x1b {
			n.state = "string-escape"
		}
	case "string-escape":
		if char == '\\' {
			n.state = "text"
		} else if char != 0x1b {
			n.state = "string"
		}
	}
}

func (n *TerminalTextNormalizer) put(char rune) {
	row := n.ensureRow(n.cursorRow)
	for len(row) < n.cursorCol {
		row = append(row, ' ')
	}
	if len(row) == n.cursorCol {
		row = append(row, char)
	} else {
		row[n.cursorCol] = char
	}
	n.rows[n.cursorRow] = row
	n.cursorCol++
}

func (n *TerminalTextNormalizer) handleEscape(final rune) {
	switch final {
	case '7':
		n.savedRow, n.savedCol = n.cursorRow, n.cursorCol
	case '8':
		n.cursorRow, n.cursorCol = n.savedRow, n.savedCol
	case 'D':
		n.cursorRow++
	case 'E':
		n.cursorRow++
		n.cursorCol = 0
	case 'M':
		n.cursorRow = max(0, n.cursorRow-1)
	case 'c':
		n.resetRows()
	}
	n.ensureRow(n.cursorRow)
}

func parseCSIParams(value string) (bool, []int) {
	private := strings.HasPrefix(value, "?") || strings.HasPrefix(value, ">")
	value = strings.TrimLeft(value, "?>")
	parts := strings.Split(value, ";")
	params := make([]int, len(parts))
	for index, part := range parts {
		if part == "" {
			continue
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				params[index] = 0
				break
			}
			params[index] = params[index]*10 + int(digit-'0')
		}
	}
	return private, params
}

func (n *TerminalTextNormalizer) handleCSI(final rune) {
	private, params := parseCSIParams(n.csi.String())
	first := 0
	if len(params) > 0 {
		first = params[0]
	}
	amount := max(1, first)
	if private && (final == 'h' || final == 'l') {
		return
	}
	switch final {
	case 'A':
		n.cursorRow = max(0, n.cursorRow-amount)
	case 'B':
		n.cursorRow += amount
	case 'C':
		n.cursorCol += amount
	case 'D':
		n.cursorCol = max(0, n.cursorCol-amount)
	case 'E':
		n.cursorRow += amount
		n.cursorCol = 0
	case 'F':
		n.cursorRow = max(0, n.cursorRow-amount)
		n.cursorCol = 0
	case 'G', '`':
		n.cursorCol = max(0, amount-1)
	case 'H', 'f':
		row, col := 1, 1
		if len(params) > 0 && params[0] != 0 {
			row = params[0]
		}
		if len(params) > 1 && params[1] != 0 {
			col = params[1]
		}
		n.cursorRow, n.cursorCol = row-1, col-1
	case 'd':
		n.cursorRow = max(0, amount-1)
	case 'J':
		n.eraseDisplay(first)
	case 'K':
		n.eraseLine(first)
	case 'P':
		row := n.ensureRow(n.cursorRow)
		end := min(len(row), n.cursorCol+amount)
		if n.cursorCol < len(row) {
			row = append(row[:n.cursorCol], row[end:]...)
			n.rows[n.cursorRow] = row
		}
	case '@':
		row := n.ensureRow(n.cursorRow)
		for range amount {
			if n.cursorCol > len(row) {
				row = append(row, []rune(strings.Repeat(" ", n.cursorCol-len(row)))...)
			}
			row = append(row[:n.cursorCol], append([]rune{' '}, row[n.cursorCol:]...)...)
		}
		n.rows[n.cursorRow] = row
	case 'X':
		row := n.ensureRow(n.cursorRow)
		for index := 0; index < amount && n.cursorCol+index < len(row); index++ {
			row[n.cursorCol+index] = ' '
		}
	case 's':
		n.savedRow, n.savedCol = n.cursorRow, n.cursorCol
	case 'u':
		n.cursorRow, n.cursorCol = n.savedRow, n.savedCol
	}
	n.ensureRow(n.cursorRow)
}

func (n *TerminalTextNormalizer) eraseDisplay(mode int) {
	if mode == 2 || mode == 3 {
		n.commitAllRows()
		n.resetRows()
		return
	}
	if mode == 0 {
		n.eraseLine(0)
		n.rows = n.rows[:min(len(n.rows), n.cursorRow+1)]
	} else if mode == 1 {
		for row := 0; row < n.cursorRow; row++ {
			n.rows[row] = nil
		}
		n.eraseLine(1)
	}
}

func (n *TerminalTextNormalizer) eraseLine(mode int) {
	row := n.ensureRow(n.cursorRow)
	switch mode {
	case 2:
		n.rows[n.cursorRow] = nil
	case 1:
		end := min(n.cursorCol, len(row)-1)
		for index := 0; index <= end; index++ {
			row[index] = ' '
		}
	default:
		if n.cursorCol < len(row) {
			n.rows[n.cursorRow] = row[:n.cursorCol]
		}
	}
}

func (n *TerminalTextNormalizer) ensureRow(index int) []rune {
	for len(n.rows) <= index {
		n.rows = append(n.rows, []rune{})
	}
	return n.rows[index]
}

func trimRow(row []rune) string {
	return strings.TrimRight(string(row), " ")
}

func (n *TerminalTextNormalizer) commitReadyRows() {
	count := max(0, n.cursorRow-n.editableRows)
	for index := 0; index < count; index++ {
		n.committed.WriteString(trimRow(n.rows[index]))
		n.committed.WriteByte('\n')
	}
	if count == 0 {
		return
	}
	n.rows = n.rows[count:]
	n.cursorRow -= count
	n.savedRow = max(0, n.savedRow-count)
}

func (n *TerminalTextNormalizer) commitAllRows() {
	last := len(n.rows) - 1
	for last >= 0 && trimRow(n.rows[last]) == "" {
		last--
	}
	if last < 0 {
		return
	}
	for index := 0; index <= last; index++ {
		n.committed.WriteString(trimRow(n.rows[index]))
		if index < last || last < len(n.rows)-1 {
			n.committed.WriteByte('\n')
		}
	}
}

func (n *TerminalTextNormalizer) resetRows() {
	n.rows = [][]rune{{}}
	n.cursorRow, n.cursorCol = 0, 0
	n.savedRow, n.savedCol = 0, 0
}

func (n *TerminalTextNormalizer) takeCommitted() string {
	value := n.committed.String()
	n.committed.Reset()
	return value
}
