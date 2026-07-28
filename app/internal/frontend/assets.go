// Package frontend exposes the production web client embedded in the muxus
// executable. The build precompresses client/dist into web before compiling.
package frontend

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var content embed.FS

func Assets() fs.FS {
	assets, err := fs.Sub(content, "web")
	if err != nil {
		panic(err)
	}
	return assets
}
