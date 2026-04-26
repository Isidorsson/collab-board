package hub

import (
	"log/slog"
	"sync/atomic"

	"github.com/Isidorsson/collab-board/internal/ws"
)

type Member interface {
	ID() string
	Name() string
	Color() string
	TrySend(payload []byte) bool
	Close()
}

type Room struct {
	code    string
	join    chan Member
	leave   chan string
	inbound chan inboundMsg
	closed  atomic.Bool
	size    atomic.Int32

	members map[string]Member
	log     *slog.Logger
}

func (r *Room) Size() int { return int(r.size.Load()) }

type inboundMsg struct {
	from    string
	msgType ws.MessageType
	data    []byte
}

func newRoom(code string, log *slog.Logger) *Room {
	r := &Room{
		code:    code,
		join:    make(chan Member, 8),
		leave:   make(chan string, 8),
		inbound: make(chan inboundMsg, 256),
		members: make(map[string]Member),
		log:     log.With("room", code),
	}
	go r.run()
	return r
}

func (r *Room) Code() string { return r.code }

func (r *Room) Join(m Member) {
	if r.closed.Load() {
		m.Close()
		return
	}
	r.join <- m
}

func (r *Room) Leave(id string) {
	if r.closed.Load() {
		return
	}
	r.leave <- id
}

func (r *Room) Send(from string, t ws.MessageType, data []byte) {
	if r.closed.Load() {
		return
	}
	r.inbound <- inboundMsg{from: from, msgType: t, data: data}
}

func (r *Room) run() {
	for {
		select {
		case m := <-r.join:
			r.members[m.ID()] = m
			r.size.Store(int32(len(r.members)))
			r.log.Info("member joined", "id", m.ID(), "name", m.Name(), "size", len(r.members))
			r.broadcastPresence()
		case id := <-r.leave:
			if _, ok := r.members[id]; ok {
				delete(r.members, id)
				r.size.Store(int32(len(r.members)))
				r.log.Info("member left", "id", id, "size", len(r.members))
				r.broadcastPresence()
			}
		case msg := <-r.inbound:
			r.fanOut(msg)
		}
	}
}

// fanOut delivers a message to every member except the sender.
//
// Backpressure: TrySend is non-blocking. If a member's send buffer is
// full we evict that member rather than stall the whole room — the
// single most important design choice in this server. One slow client
// must never wedge a room full of fast ones.
func (r *Room) fanOut(msg inboundMsg) {
	payload, err := ws.Encode(msg.msgType, msg.from, rawJSON(msg.data))
	if err != nil {
		r.log.Error("encode broadcast", "err", err)
		return
	}

	var evicted []string
	for id, m := range r.members {
		if id == msg.from {
			continue
		}
		if !m.TrySend(payload) {
			evicted = append(evicted, id)
		}
	}

	for _, id := range evicted {
		if m, ok := r.members[id]; ok {
			r.log.Warn("evicting slow client", "id", id)
			m.Close()
			delete(r.members, id)
		}
	}
	if len(evicted) > 0 {
		r.size.Store(int32(len(r.members)))
		r.broadcastPresence()
	}
}

func (r *Room) broadcastPresence() {
	users := make([]ws.PresenceUser, 0, len(r.members))
	for _, m := range r.members {
		users = append(users, ws.PresenceUser{ID: m.ID(), Name: m.Name(), Color: m.Color()})
	}
	payload, err := ws.Encode(ws.TypePresence, "", ws.PresencePayload{Users: users})
	if err != nil {
		r.log.Error("encode presence", "err", err)
		return
	}
	var evicted []string
	for id, m := range r.members {
		if !m.TrySend(payload) {
			r.log.Warn("evicting slow client on presence", "id", id)
			m.Close()
			evicted = append(evicted, id)
		}
	}
	for _, id := range evicted {
		delete(r.members, id)
	}
	if len(evicted) > 0 {
		r.size.Store(int32(len(r.members)))
	}
}

// rawJSON wraps a pre-serialized JSON byte slice so that ws.Encode does
// not double-marshal it. Without this, broadcasting a stroke would
// re-encode the bytes as a base64 string.
type rawJSON []byte

func (r rawJSON) MarshalJSON() ([]byte, error) {
	if len(r) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}
