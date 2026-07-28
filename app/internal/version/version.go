// Package version carries the build-time application version.
package version

import "os"

// Version is stamped at build time via -ldflags "-X ...=1.2.3". A `go run`
// build has no stamp and falls back to MUXUS_VERSION or the dev placeholder.
var Version = ""

func Get() string {
	if Version != "" {
		return Version
	}
	if env := os.Getenv("MUXUS_VERSION"); env != "" {
		return env
	}
	return "0.0.0"
}
