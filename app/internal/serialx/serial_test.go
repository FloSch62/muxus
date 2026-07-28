package serialx

import (
	"errors"
	"io"
	"runtime"
	"sync"
	"testing"
	"time"

	"go.bug.st/serial"

	"github.com/FloSch62/muxus/app/internal/api"
)

// Ported from tests/unit/server/serial-transport.test.ts.
func TestOpenOptionsMapsFramingAndHardwareFlowControl(t *testing.T) {
	profile := &api.SerialProfile{
		Kind:        "serial",
		Path:        "COM3",
		BaudRate:    921600,
		DataBits:    8,
		StopBits:    1,
		Parity:      "none",
		FlowControl: "hardware",
	}
	got := OpenOptions(profile)
	want := Options{
		Path: "COM3",
		Mode: serial.Mode{
			BaudRate: 921600,
			DataBits: 8,
			Parity:   serial.NoParity,
			StopBits: serial.OneStopBit,
		},
		RTSCTS: true,
		XOn:    false,
		XOff:   false,
	}
	if got != want {
		t.Fatalf("options = %+v, want %+v", got, want)
	}
}

func TestOpenOptionsMapsSoftwareFlowControlWithoutRTSCTS(t *testing.T) {
	profile := &api.SerialProfile{
		Kind:        "serial",
		Path:        "/dev/ttyUSB0",
		BaudRate:    9600,
		DataBits:    7,
		StopBits:    2,
		Parity:      "even",
		FlowControl: "software",
	}
	got := OpenOptions(profile)
	if got.RTSCTS || !got.XOn || !got.XOff {
		t.Fatalf("flow control = rtscts=%v xon=%v xoff=%v, want rtscts=false xon=true xoff=true",
			got.RTSCTS, got.XOn, got.XOff)
	}
}

func TestOpenOptionsMapsAllParitiesAndStopBits(t *testing.T) {
	parities := map[string]serial.Parity{
		"none":  serial.NoParity,
		"even":  serial.EvenParity,
		"odd":   serial.OddParity,
		"mark":  serial.MarkParity,
		"space": serial.SpaceParity,
	}
	for name, want := range parities {
		profile := &api.SerialProfile{Kind: "serial", Path: "COM3", StopBits: 1, Parity: name}
		if got := OpenOptions(profile).Mode.Parity; got != want {
			t.Fatalf("parity %q = %v, want %v", name, got, want)
		}
	}
	stopBits := map[float64]serial.StopBits{
		1:   serial.OneStopBit,
		1.5: serial.OnePointFiveStopBits,
		2:   serial.TwoStopBits,
	}
	for value, want := range stopBits {
		profile := &api.SerialProfile{Kind: "serial", Path: "COM3", StopBits: value, Parity: "none"}
		if got := OpenOptions(profile).Mode.StopBits; got != want {
			t.Fatalf("stopBits %v = %v, want %v", value, got, want)
		}
	}
}

// fakePort stands in for the OS device the way the vitest suite mocks
// node-serialport.
type fakePort struct {
	readCh chan []byte
	done   chan struct{}

	mu         sync.Mutex
	writes     [][]byte
	closeCalls int
}

func newFakePort() *fakePort {
	return &fakePort{readCh: make(chan []byte, 16), done: make(chan struct{})}
}

// closedCode reproduces the library's coded errors, which have no exported
// constructor.
type closedCode struct{ code serial.PortErrorCode }

func (e closedCode) Error() string              { return "coded serial failure" }
func (e closedCode) Code() serial.PortErrorCode { return e.code }

func (p *fakePort) Read(buf []byte) (int, error) {
	select {
	case data := <-p.readCh:
		return copy(buf, data), nil
	case <-p.done:
		return 0, closedCode{code: serial.PortClosed}
	}
}

func (p *fakePort) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, append([]byte(nil), data...))
	return len(data), nil
}

func (p *fakePort) Close() error {
	p.mu.Lock()
	p.closeCalls++
	calls := p.closeCalls
	p.mu.Unlock()
	if calls == 1 {
		close(p.done)
	}
	return nil
}

func (p *fakePort) SetMode(*serial.Mode) error { return nil }
func (p *fakePort) Drain() error               { return nil }
func (p *fakePort) ResetInputBuffer() error    { return nil }
func (p *fakePort) ResetOutputBuffer() error   { return nil }
func (p *fakePort) SetDTR(bool) error          { return nil }
func (p *fakePort) SetRTS(bool) error          { return nil }
func (p *fakePort) GetModemStatusBits() (*serial.ModemStatusBits, error) {
	return &serial.ModemStatusBits{}, nil
}
func (p *fakePort) SetReadTimeout(time.Duration) error { return nil }
func (p *fakePort) Break(time.Duration) error          { return nil }

func withFakeOpen(t *testing.T, open func(path string, mode *serial.Mode) (serial.Port, error)) {
	t.Helper()
	prev := openPort
	openPort = open
	t.Cleanup(func() { openPort = prev })
}

func testProfile() *api.SerialProfile {
	return &api.SerialProfile{
		Kind:        "serial",
		Path:        "/dev/ttyUSB0",
		BaudRate:    115200,
		DataBits:    8,
		StopBits:    1,
		Parity:      "none",
		FlowControl: "none",
	}
}

func TestConnectOpensPortWithMappedSettings(t *testing.T) {
	port := newFakePort()
	var gotPath string
	var gotMode serial.Mode
	withFakeOpen(t, func(path string, mode *serial.Mode) (serial.Port, error) {
		gotPath = path
		gotMode = *mode
		return port, nil
	})

	transport, err := Connect(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()

	if gotPath != "/dev/ttyUSB0" {
		t.Fatalf("path = %q", gotPath)
	}
	want := serial.Mode{BaudRate: 115200, DataBits: 8, Parity: serial.NoParity, StopBits: serial.OneStopBit}
	if gotMode != want {
		t.Fatalf("mode = %+v, want %+v", gotMode, want)
	}

	if _, err := transport.Write([]byte("show version\n")); err != nil {
		t.Fatal(err)
	}
	port.mu.Lock()
	writes := len(port.writes)
	port.mu.Unlock()
	if writes != 1 {
		t.Fatalf("port writes = %d, want 1", writes)
	}

	port.readCh <- []byte("SR OS")
	buf := make([]byte, 32)
	n, err := transport.Read(buf)
	if err != nil || string(buf[:n]) != "SR OS" {
		t.Fatalf("read = %q, %v", buf[:n], err)
	}

	if err := transport.Resize(120, 40); err != nil {
		t.Fatalf("resize = %v", err)
	}
}

func TestReadReportsEOFAfterCloseAndCloseIsIdempotent(t *testing.T) {
	port := newFakePort()
	withFakeOpen(t, func(string, *serial.Mode) (serial.Port, error) { return port, nil })

	transport, err := Connect(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := transport.Read(make([]byte, 8)); err != io.EOF {
		t.Fatalf("read after close = %v, want io.EOF", err)
	}

	port.mu.Lock()
	closes := port.closeCalls
	port.mu.Unlock()
	if closes != 1 {
		t.Fatalf("port closes = %d, want 1", closes)
	}
}

func TestWriteAfterCloseIsDropped(t *testing.T) {
	port := newFakePort()
	withFakeOpen(t, func(string, *serial.Mode) (serial.Port, error) { return port, nil })

	transport, err := Connect(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}

	n, err := transport.Write([]byte("late"))
	if n != 4 || err != nil {
		t.Fatalf("write after close = %d, %v", n, err)
	}
	port.mu.Lock()
	writes := len(port.writes)
	port.mu.Unlock()
	if writes != 0 {
		t.Fatalf("port writes = %d, want 0", writes)
	}
}

func TestConnectMapsOpenFailuresToFriendlyErrors(t *testing.T) {
	permissionHint := ""
	if runtime.GOOS == "linux" {
		permissionHint = " Check that your user belongs to the device’s serial-access group (commonly dialout or uucp)."
	}
	cases := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "typed permission code",
			err:  closedCode{code: serial.PermissionDenied},
			want: "Permission denied opening serial port /dev/ttyUSB0." + permissionHint,
		},
		{
			name: "permission denied message",
			err:  errors.New("open /dev/ttyUSB0: permission denied"),
			want: "Permission denied opening serial port /dev/ttyUSB0." + permissionHint,
		},
		{
			name: "typed not-found code",
			err:  closedCode{code: serial.PortNotFound},
			want: "Serial port not found: /dev/ttyUSB0",
		},
		{
			name: "no such file message",
			err:  errors.New("no such file or directory"),
			want: "Serial port not found: /dev/ttyUSB0",
		},
		{
			name: "typed busy code",
			err:  closedCode{code: serial.PortBusy},
			want: "Serial port is already in use: /dev/ttyUSB0",
		},
		{
			name: "resource busy message",
			err:  errors.New("Error: Resource busy, cannot open /dev/ttyUSB0"),
			want: "Serial port is already in use: /dev/ttyUSB0",
		},
		{
			name: "windows access is denied message",
			err:  errors.New("Opening COM3: Access is denied."),
			want: "Serial port is already in use: /dev/ttyUSB0",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withFakeOpen(t, func(string, *serial.Mode) (serial.Port, error) { return nil, tc.err })
			_, err := Connect(testProfile())
			if err == nil || err.Error() != tc.want {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestConnectPassesUnknownOpenErrorsThrough(t *testing.T) {
	boom := errors.New("kaboom")
	withFakeOpen(t, func(string, *serial.Mode) (serial.Port, error) { return nil, boom })
	if _, err := Connect(testProfile()); err != boom {
		t.Fatalf("err = %v, want the original error", err)
	}
}
