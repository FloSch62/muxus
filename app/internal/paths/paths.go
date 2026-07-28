// Package paths resolves per-user data locations. Two families exist on
// purpose: serve mode keeps the historical standalone-server paths, while
// desktop mode uses the directories the Electron shell used, so an upgrade
// finds the user's existing database and state files.
package paths

import (
	"os"
	"path/filepath"
	"runtime"
)

// ServeDataDir is the standalone-server data directory (muxus.sqlite3 home).
func ServeDataDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Muxus")
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "Muxus")
		}
		return filepath.Join(home, "AppData", "Roaming", "Muxus")
	default:
		if dataHome := os.Getenv("XDG_DATA_HOME"); dataHome != "" {
			return filepath.Join(dataHome, "muxus")
		}
		return filepath.Join(home, ".local", "share", "muxus")
	}
}

// DesktopDataDir is where the Electron shell kept userData (app.getPath):
// %APPDATA%\Muxus, ~/Library/Application Support/Muxus, ~/.config/Muxus.
// On macOS and Windows it coincides with ServeDataDir; on Linux Electron used
// the XDG *config* home rather than the data home.
func DesktopDataDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin", "windows":
		return ServeDataDir()
	default:
		if configHome := os.Getenv("XDG_CONFIG_HOME"); configHome != "" {
			return filepath.Join(configHome, "Muxus")
		}
		return filepath.Join(home, ".config", "Muxus")
	}
}

// DefaultDatabasePath returns the serve-mode database location, matching the
// Node server's defaultDatabasePath.
func DefaultDatabasePath() string {
	return filepath.Join(ServeDataDir(), "muxus.sqlite3")
}

// DesktopDatabasePath returns the desktop-mode database location (the file an
// existing Electron install already has).
func DesktopDatabasePath() string {
	return filepath.Join(DesktopDataDir(), "muxus.sqlite3")
}
