package shell

import _ "embed"

// appIcon is the same Muxus artwork used by the web client and Linux desktop
// entry, rendered as PNG for GTK, Windows, and macOS native icon decoders.
//
//go:embed appicon.png
var appIcon []byte
