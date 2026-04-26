package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"github.com/Isidorsson/collab-board/internal/hub"
	"github.com/Isidorsson/collab-board/internal/ws"
)

func WS(h *hub.Hub, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		room := strings.TrimSpace(r.URL.Query().Get("room"))
		name := strings.TrimSpace(r.URL.Query().Get("name"))
		color := strings.TrimSpace(r.URL.Query().Get("color"))
		if room == "" {
			http.Error(w, "missing ?room=", http.StatusBadRequest)
			return
		}
		if name == "" {
			name = "anon"
		}
		if color == "" {
			color = "#888"
		}

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // origin check skipped — CORS handled at edge
		})
		if err != nil {
			log.Info("ws accept failed", "err", err)
			return
		}

		room2 := h.GetOrCreate(room)
		conn := ws.NewConn(c, name, color, log)
		room2.Join(conn)
		conn.Run(r.Context(), room2)
	}
}
