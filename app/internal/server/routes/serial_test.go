package routes

import (
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.bug.st/serial/enumerator"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/server"
)

func newSerialTestApp(t *testing.T) http.Handler {
	t.Helper()
	cfg := server.ResolveConfig(server.Overrides{
		DevToken:   testToken,
		StaticRoot: "/path/that/does/not/exist",
	})
	ctx := &server.Context{Config: cfg}
	return server.NewRouter(ctx, func(r chi.Router) {
		RegisterSerialRoutes(r)
	})
}

func withFakePortList(t *testing.T, list func() ([]*enumerator.PortDetails, error)) {
	t.Helper()
	prev := listSerialPorts
	listSerialPorts = list
	t.Cleanup(func() { listSerialPorts = prev })
}

// Ported from tests/unit/server/serial-routes.test.ts.
func TestSerialPortsResponseReturnsNaturallySortedMetadata(t *testing.T) {
	got := serialPortsResponse([]*enumerator.PortDetails{
		{Name: "COM10", Manufacturer: "Acme", SerialNumber: "ten"},
		{Name: "COM2", VID: "1234", PID: "5678"},
	})
	want := api.SerialPortsResponse{
		Ports: []api.SerialPortInfo{
			{Path: "COM2", ProductID: "5678", VendorID: "1234"},
			{Path: "COM10", Manufacturer: "Acme", SerialNumber: "ten"},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("response = %+v, want %+v", got, want)
	}
}

func TestSerialPortsRouteOmitsMissingFields(t *testing.T) {
	withFakePortList(t, func() ([]*enumerator.PortDetails, error) {
		return []*enumerator.PortDetails{
			{Name: "COM10", Manufacturer: "Acme", SerialNumber: "ten"},
			{Name: "COM2", VID: "1234", PID: "5678"},
		}, nil
	})

	app := newSerialTestApp(t)
	rec := get(t, app, "/api/serial/ports", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	// Absent metadata must serialize as absent keys, matching the JSON the
	// Node server produces for undefined properties.
	want := `{"ports":[` +
		`{"path":"COM2","productId":"5678","vendorId":"1234"},` +
		`{"path":"COM10","manufacturer":"Acme","serialNumber":"ten"}]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestSerialPortsRouteReportsEnumerationFailure(t *testing.T) {
	withFakePortList(t, func() ([]*enumerator.PortDetails, error) {
		return nil, errors.New("Could not enumerate serial ports")
	})

	app := newSerialTestApp(t)
	rec := get(t, app, "/api/serial/ports", true)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Could not enumerate serial ports") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
