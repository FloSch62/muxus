package shell

import (
	"bytes"
	"image/png"
	"testing"
)

func TestEmbeddedApplicationIcon(t *testing.T) {
	config, err := png.DecodeConfig(bytes.NewReader(appIcon))
	if err != nil {
		t.Fatal(err)
	}
	if config.Width != 256 || config.Height != 256 {
		t.Fatalf("icon dimensions = %dx%d", config.Width, config.Height)
	}
}
