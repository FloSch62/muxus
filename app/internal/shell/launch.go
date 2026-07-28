package shell

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/FloSch62/muxus/app/internal/api"
)

type windowLaunch struct {
	Kind    string          `json:"kind"`
	Profile json.RawMessage `json:"profile,omitempty"`
	Title   string          `json:"title"`
	Color   string          `json:"color,omitempty"`
	ConnID  string          `json:"connId,omitempty"`
	Path    string          `json:"path,omitempty"`
}

func parseWindowLaunch(content []byte) (windowLaunch, error) {
	var launch windowLaunch
	if err := decodeJSONBody(content, &launch); err != nil {
		return launch, err
	}
	if len(launch.Title) > 500 {
		return launch, errors.New("title is too long")
	}
	switch launch.Kind {
	case "session":
		if launch.Title == "" || len(launch.Profile) == 0 {
			return launch, errors.New("session launch requires title and profile")
		}
		if _, err := api.ParseSessionProfile(launch.Profile); err != nil {
			return launch, err
		}
	case "sftp":
		launch.ConnID = strings.TrimSpace(launch.ConnID)
		if launch.ConnID == "" || len(launch.ConnID) > 200 || launch.Title == "" || len(launch.Path) > 4096 {
			return launch, errors.New("invalid SFTP launch")
		}
	default:
		return launch, errors.New("unknown window kind")
	}
	return launch, nil
}
