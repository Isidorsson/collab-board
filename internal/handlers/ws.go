package handlers

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/coder/websocket"

	"github.com/Isidorsson/collab-board/internal/hub"
	"github.com/Isidorsson/collab-board/internal/ws"
)

func WS(h *hub.Hub, log *slog.Logger) http.HandlerFunc {
	opts := acceptOptions()
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

		c, err := websocket.Accept(w, r, opts)
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

// acceptOptions builds the WebSocket Accept options once at startup.
// If ALLOWED_ORIGINS is set (comma-separated host patterns, e.g.
// "example.com,*.example.com") origin checking is enforced. If unset we
// fall back to InsecureSkipVerify for local development convenience —
// production deployments should always set ALLOWED_ORIGINS.
func acceptOptions() *websocket.AcceptOptions {
	raw := strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS"))
	if raw == "" {
		return &websocket.AcceptOptions{InsecureSkipVerify: true}
	}
	parts := strings.Split(raw, ",")
	patterns := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			patterns = append(patterns, p)
		}
	}
	return &websocket.AcceptOptions{OriginPatterns: patterns}
}
