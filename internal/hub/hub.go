package hub

import (
	"log/slog"
	"sync"
)

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
	log   *slog.Logger
}

func New(log *slog.Logger) *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
		log:   log,
	}
}

func (h *Hub) GetOrCreate(code string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[code]; ok {
		return r
	}
	r := newRoom(code, h.log)
	h.rooms[code] = r
	return r
}

func (h *Hub) Stats() (rooms int, members int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	rooms = len(h.rooms)
	for _, r := range h.rooms {
		members += r.Size()
	}
	return
}
