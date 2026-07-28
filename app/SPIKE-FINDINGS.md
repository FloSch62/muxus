# Wails v3 spike findings (alpha2.119, pinned)

Source-level verification against `$GOMODCACHE/github.com/wailsapp/wails/v3@v3.0.0-alpha2.119`.

## Resolved

| Flag | Verdict | Evidence |
|---|---|---|
| Pluggable transport (mount `/wails/runtime` in our router) | **Exists** | `pkg/application/transport.go`: `Transport` iface, `AssetServerTransport.ServeAssets`, `TransportHTTPHandler`; `application_options.go:123` `Transport Transport` |
| `WebviewWindowOptions.URL` external origin | **Exists** | `webview_window_options.go:60` |
| `Frameless`, `Zoom`, `CSS` | **Exist** | `:66`, `:144`, `:123` |
| `KeyBindings` (chords) | **Exists** | `:188` `map[string]func(window Window)` |
| Windows native drag regions | **Exists** | `:347` `NonClientRegionSupport` |
| macOS hidden titlebar + drag height | **Exists** | `:561` `Mac.TitleBar MacTitleBar`, `:565` `InvisibleTitleBarHeight` |
| Single-instance | **Exists** | `single_instance_{linux,darwin,windows}.go`, `SingleInstanceOptions` |
| Native dialogs | **Exist** | `dialogs_{linux,darwin,windows}.go` |
| `options.JS` injection timing | **LOAD-FINISHED, not document-start** (Linux: `webview_window_linux.go:371-375` runs on `WindowLoadFinished`) → unusable for the boot payload |
| Runtime core availability on external URLs | Injected on every `WindowLoadFinished` regardless of origin (`webview_window_linux.go:384+` `RegisterHook … runtime.Core(...)`) |

## Design consequence

Boot payload moves off `options.JS` to the **URL fragment** (`#token=…&launch=…&shell=…&platform=…`) — the exact mechanism the client already implements for browser mode — plus a `GET /api/desktop/state` pre-hydration awaited via top-level await in the client adapter before any store initializes. No dependency on injection timing remains.

## Run spike results (Linux, gtk3 tag, WebKit2Gtk 2.52.3, app/spike)

The Linux build needs `-tags gtk3` (alpha2.119 defaults to GTK4 + webkitgtk-6.0;
the gtk3 tag selects GTK3 + webkit2gtk-4.1). Ship decision: gtk3 for distro reach.

| Question | Verdict |
|---|---|
| Webview loads an external `http://127.0.0.1:<port>` origin + fetch + CSP | **Works** (real muxus CSP headers active) |
| Core bootstrap (`window._wails.invoke` shim) injected into external-origin pages | **Works** — injected at load-finished |
| postMessage bridge (`webkit.messageHandlers.external`) on our origin | **Works** — `runtime:ready` reached Go |
| Runtime-ready contract | The full runtime lives in the **`@wailsio/runtime` npm package the client must bundle**; it announces `wails:runtime:ready` on import, which unblocks Go-side `ExecJS` (queued until ready) and the rest of the runtime surface. `runtime.Core()` injection is only the invoke shim. |
| Transport mount | `application.NewHTTPTransport()` passed via `Options.Transport`, its `Handler()` middleware mounted in the muxus chi router → `/wails/runtime` served on our origin. Compiles and runs; full call round-trip exercised in M6. |
| `SetZoom` on WebKitGTK | **Works** (devicePixelRatio scaled to 1.25) |
| WASM / module workers / clipboard / `document.fonts` / localStorage | All present in WebKitGTK |
| CSS `app-region` / `-webkit-app-region` | **Not supported** on WebKitGTK → Linux drag must use `--wails-draggable` (runtime JS tracking), as planned |

## Migration outcome

- The real client bundles `@wailsio/runtime`, pre-hydrates desktop state and
  runs REST and WebSocket traffic through the loopback origin.
- KeyBindings dispatch the native close/cycle chords into the client.
- Production assets are precompressed and embedded in the single executable.
- CI compiles and packages Linux, macOS and Windows; Linux uses `-tags gtk3`.
