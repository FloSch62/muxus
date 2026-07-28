//go:build !production

package server

import (
	"os"
	"path/filepath"
)

// defaultStaticRoot finds client/dist in source checkouts. Release builds use
// only the embedded client unless --static-root explicitly opts into files.
func defaultStaticRoot() string {
	exe, err := os.Executable()
	candidates := []string{"client/dist", "../client/dist"}
	if err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "client"))
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil {
			absolute, _ := filepath.Abs(candidate)
			return absolute
		}
	}
	return ""
}
