package routes

import (
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"go.bug.st/serial/enumerator"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/server"
)

// listSerialPorts is a seam for tests: the suite substitutes fake device
// listings the way the vitest suite mocks SerialPort.list().
var listSerialPorts = func() ([]*enumerator.PortDetails, error) {
	return enumerator.GetDetailedPortsList()
}

// serialPortsResponse mirrors serialPortsResponse: OS metadata mapped onto
// the DTO in natural path order. The enumerator exposes no pnpId or
// locationId equivalents, so those keys stay absent.
func serialPortsResponse(ports []*enumerator.PortDetails) api.SerialPortsResponse {
	infos := make([]api.SerialPortInfo, 0, len(ports))
	for _, port := range ports {
		infos = append(infos, api.SerialPortInfo{
			Path:         port.Name,
			Manufacturer: port.Manufacturer,
			SerialNumber: port.SerialNumber,
			ProductID:    port.PID,
			VendorID:     port.VID,
		})
	}
	sort.SliceStable(infos, func(i, j int) bool {
		return naturalCompare(infos[i].Path, infos[j].Path) < 0
	})
	return api.SerialPortsResponse{Ports: infos}
}

// naturalCompare orders like localeCompare with numeric collation: digit
// runs compare as numbers, so COM2 sorts before COM10.
func naturalCompare(a, b string) int {
	for a != "" && b != "" {
		if isDigit(a[0]) && isDigit(b[0]) {
			var aRun, bRun string
			aRun, a = splitDigitRun(a)
			bRun, b = splitDigitRun(b)
			if c := compareDigitRuns(aRun, bRun); c != 0 {
				return c
			}
			continue
		}
		if a[0] != b[0] {
			if a[0] < b[0] {
				return -1
			}
			return 1
		}
		a, b = a[1:], b[1:]
	}
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		return -1
	default:
		return 1
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func splitDigitRun(s string) (run, rest string) {
	i := 0
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	return s[:i], s[i:]
}

func compareDigitRuns(a, b string) int {
	// Compare as numbers of arbitrary size: strip leading zeros, then a
	// longer run is larger and equal lengths compare lexicographically.
	a = strings.TrimLeft(a, "0")
	b = strings.TrimLeft(b, "0")
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// RegisterSerialRoutes mirrors registerSerialRoutes: enumerate OS serial
// devices for the saved-host editor.
func RegisterSerialRoutes(r chi.Router) {
	r.Get("/api/serial/ports", func(w http.ResponseWriter, _ *http.Request) {
		ports, err := listSerialPorts()
		if err != nil {
			// The Node route lets a listing failure surface as a 500
			// carrying the error message.
			server.WriteJSON(w, http.StatusInternalServerError, api.ErrorBody{Message: err.Error()})
			return
		}
		server.WriteJSON(w, http.StatusOK, serialPortsResponse(ports))
	})
}
