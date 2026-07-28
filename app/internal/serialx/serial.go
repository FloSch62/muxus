// Package serialx opens serial-port terminal sessions, porting
// server/src/serial/serial-transport.ts onto go.bug.st/serial.
package serialx

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"regexp"
	"runtime"
	"sync"

	"go.bug.st/serial"

	"github.com/FloSch62/muxus/app/internal/api"
)

// Options mirrors the node-serialport open options serialOpenOptions
// produces. go.bug.st/serial's Mode has no flow-control fields (the library
// unconditionally disables RTS/CTS and XON/XOFF), so the flow-control flags
// are kept alongside the Mode for contract parity but cannot be applied to
// the device.
type Options struct {
	Path   string
	Mode   serial.Mode
	RTSCTS bool
	XOn    bool
	XOff   bool
}

// OpenOptions mirrors serialOpenOptions: profile framing and flow control
// mapped onto the library's open parameters.
func OpenOptions(profile *api.SerialProfile) Options {
	return Options{
		Path: profile.Path,
		Mode: serial.Mode{
			BaudRate: profile.BaudRate,
			DataBits: profile.DataBits,
			Parity:   parityMode(profile.Parity),
			StopBits: stopBitsMode(profile.StopBits),
		},
		RTSCTS: profile.FlowControl == "hardware",
		XOn:    profile.FlowControl == "software",
		XOff:   profile.FlowControl == "software",
	}
}

// Profile parsing already restricts parity to the five node-serialport
// names, so the defaults below are unreachable rather than lenient.
func parityMode(parity string) serial.Parity {
	switch parity {
	case "even":
		return serial.EvenParity
	case "odd":
		return serial.OddParity
	case "mark":
		return serial.MarkParity
	case "space":
		return serial.SpaceParity
	default:
		return serial.NoParity
	}
}

func stopBitsMode(stopBits float64) serial.StopBits {
	switch stopBits {
	case 1.5:
		return serial.OnePointFiveStopBits
	case 2:
		return serial.TwoStopBits
	default:
		return serial.OneStopBit
	}
}

// openPort is a seam for tests: the suite substitutes an in-memory port the
// way the vitest suite mocks node-serialport.
var openPort = func(path string, mode *serial.Mode) (serial.Port, error) {
	return serial.Open(path, mode)
}

// Transport is an open serial session satisfying the terminal-socket
// transport contract.
type Transport struct {
	port serial.Port

	mu    sync.Mutex
	ended bool
}

// Connect mirrors SerialTransport.connect: open the device with the mapped
// settings, translating open failures into actionable messages.
func Connect(profile *api.SerialProfile) (*Transport, error) {
	opts := OpenOptions(profile)
	port, err := openPort(opts.Path, &opts.Mode)
	if err != nil {
		return nil, friendlySerialError(err, profile.Path)
	}
	return &Transport{port: port}, nil
}

// Read delivers device bytes. A closed port — locally or by device removal —
// reads as io.EOF, the pull-based equivalent of the Node 'close' event.
func (t *Transport) Read(p []byte) (int, error) {
	n, err := t.port.Read(p)
	if err != nil {
		if code, ok := portCode(err); ok && code == serial.PortClosed {
			return n, io.EOF
		}
	}
	return n, err
}

// Write drops data once the transport has ended, matching the Node write's
// `!ended && isOpen` guard.
func (t *Transport) Write(p []byte) (int, error) {
	t.mu.Lock()
	ended := t.ended
	t.mu.Unlock()
	if ended {
		return len(p), nil
	}
	return t.port.Write(p)
}

// Resize is a no-op: serial links have no standard window-size negotiation.
func (t *Transport) Resize(_, _ int) error {
	return nil
}

// Close is idempotent, like the Node close's ended guard.
func (t *Transport) Close() error {
	t.mu.Lock()
	if t.ended {
		t.mu.Unlock()
		return nil
	}
	t.ended = true
	t.mu.Unlock()
	return t.port.Close()
}

var (
	permissionPattern = regexp.MustCompile(`(?i)permission denied`)
	notFoundPattern   = regexp.MustCompile(`(?i)no such file|file not found`)
	busyPattern       = regexp.MustCompile(`(?i)cannot lock port|resource busy|access is denied`)
)

// portCode extracts the library's typed error code. Matched through an
// interface because serial.PortError has no exported constructor and no
// Unwrap, and so tests can produce coded failures.
func portCode(err error) (serial.PortErrorCode, bool) {
	var coded interface{ Code() serial.PortErrorCode }
	if errors.As(err, &coded) {
		return coded.Code(), true
	}
	return 0, false
}

// friendlySerialError mirrors friendlySerialError. Node matches errno codes
// plus message patterns; go.bug.st reports typed codes instead (e.g. EBUSY
// becomes PortBusy with a message no Node pattern would catch), so both
// forms are checked.
func friendlySerialError(err error, path string) error {
	code, coded := portCode(err)
	switch {
	case coded && code == serial.PermissionDenied,
		errors.Is(err, fs.ErrPermission),
		permissionPattern.MatchString(err.Error()):
		hint := ""
		if runtime.GOOS == "linux" {
			hint = " Check that your user belongs to the device’s serial-access group (commonly dialout or uucp)."
		}
		return fmt.Errorf("Permission denied opening serial port %s.%s", path, hint)
	case coded && code == serial.PortNotFound,
		errors.Is(err, fs.ErrNotExist),
		notFoundPattern.MatchString(err.Error()):
		return fmt.Errorf("Serial port not found: %s", path)
	case coded && code == serial.PortBusy,
		busyPattern.MatchString(err.Error()):
		return fmt.Errorf("Serial port is already in use: %s", path)
	}
	return err
}
