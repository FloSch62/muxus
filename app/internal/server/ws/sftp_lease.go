package ws

import (
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/sshx"
)

// RegisterSFTPLeaseSocket gives a detached SFTP window an explicit transport
// lease. WebSocket lifetime provides reliable cleanup even if the webview
// exits without running unload handlers.
func RegisterSFTPLeaseSocket(r chi.Router, ctx *server.Context) {
	r.Get("/ws/sftp/{connId}/lease", func(w http.ResponseWriter, req *http.Request) {
		conn, err := UpgradeTerminal(w, req, ctx.Config.Token)
		if err != nil {
			return
		}
		lease := ctx.Connections.Acquire(chi.URLParam(req, "connId"), sshx.OwnerSftp)
		if lease == nil {
			_ = conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "connection not found"),
				time.Now().Add(time.Second),
			)
			_ = conn.Close()
			return
		}
		go func() {
			var once sync.Once
			unsubscribe := func() {}
			release := func() {
				once.Do(func() {
					unsubscribe()
					lease.Release()
					_ = conn.Close()
				})
			}
			unsubscribe = lease.Connection.OnClose(func(string) {
				_ = conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "connection closed"),
					time.Now().Add(time.Second),
				)
				release()
			})
			defer release()
			if err := conn.WriteMessage(websocket.TextMessage, []byte("ready")); err != nil {
				return
			}
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()
	})
}
