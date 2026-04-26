package handlers

import (
	"fmt"
	"net/http"

	"github.com/Isidorsson/collab-board/internal/hub"
)

func Health() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	}
}

// Metrics returns a tiny Prometheus-flavored exposition. Hand-rolled to
// avoid pulling the prometheus client into a weekend MVP.
func Metrics(h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rooms, members := h.Stats()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "# HELP collab_rooms_active Active rooms.\n")
		fmt.Fprintf(w, "# TYPE collab_rooms_active gauge\n")
		fmt.Fprintf(w, "collab_rooms_active %d\n", rooms)
		fmt.Fprintf(w, "# HELP collab_members_active Active members across all rooms.\n")
		fmt.Fprintf(w, "# TYPE collab_members_active gauge\n")
		fmt.Fprintf(w, "collab_members_active %d\n", members)
	}
}
