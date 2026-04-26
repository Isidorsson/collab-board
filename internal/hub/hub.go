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
	r := newRoom(code, h.log, func() { h.removeIfEmpty(code) })
	h.rooms[code] = r
	return r
}

// removeIfEmpty deletes the room from the registry if it is still empty
// when the registry lock is acquired. The TOCTOU window matters: a new
// client may have called GetOrCreate between the room's run-loop seeing
// an empty member list and this callback running, in which case the
// room must stay alive.
func (h *Hub) removeIfEmpty(code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[code]
	if !ok {
		return
	}
	if r.Size() != 0 {
		return
	}
	r.close()
	delete(h.rooms, code)
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
