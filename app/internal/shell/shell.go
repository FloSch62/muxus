// Package shell owns the Wails desktop lifecycle. The web application still
// runs on muxus' authenticated loopback HTTP server; Wails contributes only
// the native windows, platform integration, and its transport mounted into
// that same router.
package shell

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/FloSch62/muxus/app/internal/paths"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/server/routes"
)

const titleBarHeight = 52

type Options struct {
	Config         server.Config
	RegisterRoutes func(chi.Router)
	CloseBackend   func() error
}

type manager struct {
	app       *application.App
	baseURL   string
	token     string
	state     *clientState
	statePath string

	mu       sync.Mutex
	primary  *application.WebviewWindow
	windows  map[string]*application.WebviewWindow
	nextID   uint64
	shutdown sync.Once
	close    func() error
}

func Run(options Options) error {
	transport := application.NewHTTPTransport()
	dataDir := paths.DesktopDataDir()
	m := &manager{
		token:     options.Config.Token,
		statePath: filepath.Join(dataDir, "window-state.json"),
		windows:   map[string]*application.WebviewWindow{},
	}
	m.state = openClientState(filepath.Join(dataDir, "client-state.json"), func() {
		m.emitAll("muxus:state:write-failed")
	})

	var closeHooks []func() error
	if options.CloseBackend != nil {
		closeHooks = append(closeHooks, options.CloseBackend)
	}
	running, err := server.Start(options.Config, func(r chi.Router) {
		r.Use(transport.Handler())
		options.RegisterRoutes(r)
		m.registerDesktopRoutes(r)
	}, closeHooks...)
	if err != nil {
		_ = m.state.Close()
		if options.CloseBackend != nil {
			_ = options.CloseBackend()
		}
		return err
	}
	m.baseURL = running.URL
	m.close = func() error {
		var closeErr error
		m.shutdown.Do(func() {
			if err := m.state.Close(); err != nil {
				closeErr = err
			}
			if err := running.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		})
		return closeErr
	}

	appOptions := application.Options{
		Name:        "Muxus",
		Description: "SSH, Telnet, and serial terminal",
		Icon:        appIcon,
		Transport:   transport,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: false},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: false,
			ProgramName:                   "muxus",
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "io.github.flosch62.muxus",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				m.focusPrimary()
			},
		},
		OnShutdown: func() {
			_ = m.close()
		},
	}
	m.app = application.New(appOptions)
	m.installMenu()
	m.createWindow(nil)

	runErr := m.app.Run()
	closeErr := m.close()
	if runErr != nil {
		return runErr
	}
	return closeErr
}

func (m *manager) registerDesktopRoutes(r chi.Router) {
	r.Get("/api/desktop/state", func(w http.ResponseWriter, _ *http.Request) {
		server.WriteJSON(w, http.StatusOK, m.state.Snapshot())
	})
	r.Put("/api/desktop/state/{name}", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		if name == "" || len(name) > 500 {
			server.WriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid state key"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, 8<<20))
		if err != nil {
			server.WriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request"})
			return
		}
		var value struct {
			Value string `json:"value"`
		}
		if json.Unmarshal(body, &value) != nil {
			server.WriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request"})
			return
		}
		m.state.Set(name, value.Value)
		w.WriteHeader(http.StatusNoContent)
	})
	r.Delete("/api/desktop/state/{name}", func(w http.ResponseWriter, req *http.Request) {
		m.state.Remove(chi.URLParam(req, "name"))
		w.WriteHeader(http.StatusNoContent)
	})
	r.Post("/api/desktop/windows", func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
		if err != nil {
			server.WriteJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request"})
			return
		}
		launch, err := parseWindowLaunch(body)
		if err != nil {
			server.WriteJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
			return
		}
		m.createWindow(&launch)
		w.WriteHeader(http.StatusNoContent)
	})
}

func (m *manager) createWindow(launch *windowLaunch) *application.WebviewWindow {
	state := readWindowState(m.statePath)
	m.mu.Lock()
	isPrimary := m.primary == nil
	m.nextID++
	name := fmt.Sprintf("muxus-%d", m.nextID)
	m.mu.Unlock()

	width, height := state.Width, state.Height
	if launch != nil && launch.Kind == "sftp" {
		width = clamp(width, 960, 1280)
		height = clamp(height, 640, 900)
	}
	title := "Muxus"
	if launch != nil {
		title = launch.Title + " — Muxus"
	}
	options := application.WebviewWindowOptions{
		Name:               name,
		Title:              title,
		Width:              width,
		Height:             height,
		MinWidth:           800,
		MinHeight:          500,
		URL:                m.windowURL(launch),
		Frameless:          runtime.GOOS != "darwin",
		BackgroundColour:   application.NewRGBA(21, 21, 24, 255),
		UseApplicationMenu: runtime.GOOS == "darwin",
		Windows: application.WindowsWindow{
			NonClientRegionSupport:  true,
			DisableMenu:             true,
			WindowDidMoveDebounceMS: 75,
		},
		Linux: application.LinuxWindow{
			WindowDidMoveDebounceMS: 75,
		},
		Mac: application.MacWindow{
			TitleBar:                application.MacTitleBarHidden,
			InvisibleTitleBarHeight: titleBarHeight,
			TabbingMode:             application.MacWindowTabbingModeDisallowed,
		},
		KeyBindings: map[string]func(application.Window){
			"ctrl+r": func(window application.Window) {
				window.Reload()
			},
			"ctrl+shift+r": func(window application.Window) {
				window.ForceReload()
			},
			"f11": func(window application.Window) {
				window.ToggleFullscreen()
			},
			"ctrl+tab": func(window application.Window) {
				window.EmitEvent("muxus:cycle-tab", false)
			},
			"ctrl+shift+tab": func(window application.Window) {
				window.EmitEvent("muxus:cycle-tab", true)
			},
			"cmd+w": func(window application.Window) {
				if runtime.GOOS == "darwin" {
					window.EmitEvent("muxus:close-tab")
				}
			},
			"cmd+shift+[": func(window application.Window) {
				if runtime.GOOS == "darwin" {
					window.EmitEvent("muxus:cycle-tab", true)
				}
			},
			"cmd+shift+]": func(window application.Window) {
				if runtime.GOOS == "darwin" {
					window.EmitEvent("muxus:cycle-tab", false)
				}
			},
		},
	}
	if state.X != nil && state.Y != nil {
		x, y := *state.X, *state.Y
		if !isPrimary {
			x += 28
			y += 28
		}
		options.InitialPosition = application.WindowXY
		options.X, options.Y = x, y
	}
	if isPrimary && state.Maximized {
		options.StartState = application.WindowStateMaximised
	}

	window := m.app.Window.NewWithOptions(options)
	m.mu.Lock()
	m.windows[name] = window
	if isPrimary {
		m.primary = window
	}
	m.mu.Unlock()
	window.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		if isPrimary {
			m.savePrimaryState(window, state)
		}
		m.mu.Lock()
		delete(m.windows, name)
		if m.primary == window {
			m.primary = nil
		}
		m.mu.Unlock()
	})
	return window
}

func (m *manager) windowURL(launch *windowLaunch) string {
	target, _ := url.Parse(m.baseURL)
	fragment := url.Values{}
	fragment.Set("token", m.token)
	fragment.Set("shell", "1")
	fragment.Set("platform", routes.NodePlatform())
	if launch != nil {
		content, _ := json.Marshal(launch)
		fragment.Set("launch", base64.RawURLEncoding.EncodeToString(content))
	}
	target.Fragment = fragment.Encode()
	return target.String()
}

func (m *manager) savePrimaryState(window *application.WebviewWindow, previous windowState) {
	maximized := window.IsMaximised()
	state := previous
	state.Maximized = maximized
	if !maximized {
		width, height := window.Size()
		x, y := window.Position()
		if width > 0 && height > 0 {
			state.Width, state.Height = width, height
		}
		state.X, state.Y = &x, &y
	}
	_ = writeJSONAtomic(m.statePath, state)
}

func (m *manager) focusPrimary() {
	m.mu.Lock()
	window := m.primary
	if window == nil {
		for _, candidate := range m.windows {
			window = candidate
			break
		}
	}
	m.mu.Unlock()
	if window != nil {
		window.Restore()
		window.Focus()
	}
}

func (m *manager) emitAll(name string, data ...any) {
	m.mu.Lock()
	windows := make([]*application.WebviewWindow, 0, len(m.windows))
	for _, window := range m.windows {
		windows = append(windows, window)
	}
	m.mu.Unlock()
	for _, window := range windows {
		window.EmitEvent(name, data...)
	}
}

func (m *manager) installMenu() {
	// Electron kept this application menu for accelerators but hid its window
	// bar outside macOS. Wails' GTK3 backend always promotes a configured
	// application menu into the window, even when UseApplicationMenu is false,
	// so install it only where it is truly global.
	if runtime.GOOS != "darwin" {
		return
	}
	menu := m.app.NewMenu()
	menu.AddRole(application.AppMenu)
	menu.AddRole(application.FileMenu)
	menu.AddRole(application.EditMenu)
	view := menu.AddSubmenu("View")
	view.AddRole(application.Reload)
	view.AddRole(application.ForceReload)
	view.AddRole(application.OpenDevTools)
	view.AddSeparator()
	view.AddRole(application.ToggleFullscreen)
	menu.AddRole(application.WindowMenu)
	m.app.Menu.Set(menu)
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
