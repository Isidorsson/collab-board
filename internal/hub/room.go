package hub

import (
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/Isidorsson/collab-board/internal/ws"
)

type Member interface {
	ID() string
	Name() string
	Color() string
	TrySend(payload []byte) bool
	Close()
	BufferDepth() int
	BufferCap() int
}

const (
	// maxHistorySize bounds per-room stroke memory and the size of the
	// snapshot sent to late joiners. When exceeded, oldest strokes are
	// dropped — the board is ephemeral by design, not a persistent log.
	maxHistorySize = 2000

	// maxTextCount bounds per-room text-box memory. Updates to an
	// existing box replace in place; only new IDs grow the count, so
	// this cap really limits distinct boxes, not edits.
	maxTextCount = 500

	// roomCapacity is advisory only. It is reported to clients in
	// room_meta so the UI can show "X / N in room". The server does
	// not currently enforce it; doing so would be a separate change.
	roomCapacity = 50
)

type Room struct {
	code      string
	createdAt time.Time

	join    chan Member
	leave   chan string
	inbound chan inboundMsg
	done    chan struct{}
	closed  atomic.Bool
	size    atomic.Int32

	// evictions counts how many slow clients have been booted from this
	// room since it opened. Exposed via the HUD pong telemetry so the
	// backpressure design is observable in the UI, not just in logs.
	evictions atomic.Int64

	members map[string]Member
	history []ws.StrokePayload
	// Insertion-ordered so snapshots replay in the order boxes appeared;
	// textIndex maps id -> position for O(1) update.
	texts     []ws.TextPayload
	textIndex map[string]int
	log       *slog.Logger
	onEmpty   func()
}

func (r *Room) Size() int { return int(r.size.Load()) }

type inboundMsg struct {
	from    string
	msgType ws.MessageType
	data    []byte
}

func newRoom(code string, log *slog.Logger, onEmpty func()) *Room {
	r := &Room{
		code:      code,
		createdAt: time.Now(),
		join:      make(chan Member, 8),
		leave:     make(chan string, 8),
		inbound:   make(chan inboundMsg, 256),
		done:      make(chan struct{}),
		members:   make(map[string]Member),
		textIndex: make(map[string]int),
		log:       log.With("room", code),
		onEmpty:   onEmpty,
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
	select {
	case r.join <- m:
	case <-r.done:
		m.Close()
	}
}

func (r *Room) Leave(id string) {
	if r.closed.Load() {
		return
	}
	select {
	case r.leave <- id:
	case <-r.done:
	}
}

func (r *Room) Send(from string, t ws.MessageType, data []byte) {
	if r.closed.Load() {
		return
	}
	select {
	case r.inbound <- inboundMsg{from: from, msgType: t, data: data}:
	case <-r.done:
	}
}

// close stops the run loop. Idempotent. Only the Hub should call this,
// and only after taking the registry lock to prevent a join racing with
// eviction.
func (r *Room) close() {
	if r.closed.CompareAndSwap(false, true) {
		close(r.done)
	}
}

func (r *Room) run() {
	for {
		select {
		case <-r.done:
			return
		case m := <-r.join:
			r.members[m.ID()] = m
			r.size.Store(int32(len(r.members)))
			r.log.Info("member joined", "id", m.ID(), "name", m.Name(), "size", len(r.members))
			r.sendInit(m)
			r.broadcastPresence()
		case id := <-r.leave:
			if _, ok := r.members[id]; ok {
				delete(r.members, id)
				r.size.Store(int32(len(r.members)))
				r.log.Info("member left", "id", id, "size", len(r.members))
				r.broadcastPresence()
				if len(r.members) == 0 && r.onEmpty != nil {
					r.onEmpty()
				}
			}
		case msg := <-r.inbound:
			switch msg.msgType {
			case ws.TypeStroke:
				r.recordStroke(msg.data)
				r.fanOut(msg)
			case ws.TypeStrokeUndo:
				if r.applyUndo(msg.data) {
					r.fanOut(msg)
				}
			case ws.TypeText:
				r.recordText(msg.data)
				r.fanOut(msg)
			case ws.TypeTextDelete:
				if r.applyTextDelete(msg.data) {
					r.fanOut(msg)
				}
			case ws.TypeClear:
				r.history = r.history[:0]
				r.texts = r.texts[:0]
				r.textIndex = make(map[string]int)
				r.broadcastClear(msg.from)
			case ws.TypePing:
				r.handlePing(msg)
			default:
				r.fanOut(msg)
			}
		}
	}
}

// recordStroke appends a stroke to the bounded history. The decode is
// cheap and lets snapshot encoding emit a typed array instead of a
// concatenation of pre-marshalled bytes.
func (r *Room) recordStroke(raw []byte) {
	var s ws.StrokePayload
	if err := json.Unmarshal(raw, &s); err != nil {
		r.log.Debug("stroke decode failed", "err", err)
		return
	}
	if len(r.history) >= maxHistorySize {
		// Drop the oldest stroke. copy+shrink keeps the backing array
		// bounded; growing forever via reslicing alone would not.
		copy(r.history, r.history[1:])
		r.history = r.history[:len(r.history)-1]
	}
	r.history = append(r.history, s)
}

// applyUndo removes every stroke and text box matching the payload's
// GroupID from history. Returns true when at least one item was
// removed — the caller uses that signal to decide whether to fan the
// undo out. An empty GroupID is rejected so a malformed message
// cannot wipe legacy (ungrouped) items that happen to share an empty
// ID.
func (r *Room) applyUndo(raw []byte) bool {
	var p ws.StrokeUndoPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		r.log.Debug("undo decode failed", "err", err)
		return false
	}
	if p.GroupID == "" {
		return false
	}
	kept := r.history[:0]
	removed := 0
	for _, s := range r.history {
		if s.GroupID == p.GroupID {
			removed++
			continue
		}
		kept = append(kept, s)
	}
	r.history = kept

	// Undo also evicts any text box stamped with the same group.
	if len(r.texts) > 0 {
		keptTexts := r.texts[:0]
		for _, t := range r.texts {
			if t.GroupID == p.GroupID {
				removed++
				continue
			}
			keptTexts = append(keptTexts, t)
		}
		if len(keptTexts) != len(r.texts) {
			r.texts = keptTexts
			r.rebuildTextIndex()
		}
	}
	return removed > 0
}

// Bound is on distinct IDs (not edits), so typing into one box for an
// hour doesn't fill the buffer.
func (r *Room) recordText(raw []byte) {
	var t ws.TextPayload
	if err := json.Unmarshal(raw, &t); err != nil {
		r.log.Debug("text decode failed", "err", err)
		return
	}
	if t.ID == "" {
		return
	}
	if idx, ok := r.textIndex[t.ID]; ok {
		r.texts[idx] = t
		return
	}
	if len(r.texts) >= maxTextCount {
		oldest := r.texts[0]
		delete(r.textIndex, oldest.ID)
		copy(r.texts, r.texts[1:])
		r.texts = r.texts[:len(r.texts)-1]
		r.rebuildTextIndex()
	}
	r.textIndex[t.ID] = len(r.texts)
	r.texts = append(r.texts, t)
}

func (r *Room) applyTextDelete(raw []byte) bool {
	var p ws.TextDeletePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return false
	}
	if p.ID == "" {
		return false
	}
	idx, ok := r.textIndex[p.ID]
	if !ok {
		return false
	}
	r.texts = append(r.texts[:idx], r.texts[idx+1:]...)
	r.rebuildTextIndex()
	return true
}

func (r *Room) rebuildTextIndex() {
	r.textIndex = make(map[string]int, len(r.texts))
	for i, t := range r.texts {
		r.textIndex[t.ID] = i
	}
}

// sendInit pushes room_meta and (if non-empty) a stroke snapshot to a
// freshly-joined member. If the member's send buffer is already full
// on join — which would be highly unusual but possible — we evict for
// the same reason fanOut does: never let a slow client stall the room.
func (r *Room) sendInit(m Member) {
	meta, err := ws.Encode(ws.TypeRoomMeta, "", ws.RoomMetaPayload{
		Code:      r.code,
		CreatedAt: r.createdAt.UnixMilli(),
		Capacity:  roomCapacity,
	})
	if err != nil {
		r.log.Error("encode room_meta", "err", err)
		return
	}
	if !m.TrySend(meta) {
		r.evictOne(m)
		return
	}
	if len(r.history) == 0 && len(r.texts) == 0 {
		return
	}
	snap, err := ws.Encode(ws.TypeSnapshot, "", ws.SnapshotPayload{
		Strokes: r.history,
		Texts:   r.texts,
	})
	if err != nil {
		r.log.Error("encode snapshot", "err", err)
		return
	}
	if !m.TrySend(snap) {
		r.evictOne(m)
	}
}

// broadcastClear resets every client's canvas. The sender is included
// — intentional, so a clear from one tab applies across other tabs the
// same user might have open.
func (r *Room) broadcastClear(from string) {
	payload, err := ws.Encode(ws.TypeClear, from, struct{}{})
	if err != nil {
		r.log.Error("encode clear", "err", err)
		return
	}
	var evicted []string
	for id, m := range r.members {
		if !m.TrySend(payload) {
			evicted = append(evicted, id)
		}
	}
	for _, id := range evicted {
		if m, ok := r.members[id]; ok {
			r.log.Warn("evicting slow client on clear", "id", id)
			m.Close()
			delete(r.members, id)
			r.evictions.Add(1)
		}
	}
	if len(evicted) > 0 {
		r.size.Store(int32(len(r.members)))
		r.broadcastPresence()
		if len(r.members) == 0 && r.onEmpty != nil {
			r.onEmpty()
		}
	}
}

func (r *Room) evictOne(m Member) {
	r.log.Warn("evicting slow client on init", "id", m.ID())
	m.Close()
	delete(r.members, m.ID())
	r.size.Store(int32(len(r.members)))
	r.evictions.Add(1)
}

// handlePing replies to the sender alone with a pong that carries the
// echoed nonce and a snapshot of room telemetry. Stats are piggy-backed
// on pong (rather than fired as a separate broadcast) so the client HUD
// updates at exactly the ping cadence with one round trip.
func (r *Room) handlePing(msg inboundMsg) {
	var p ws.PingPayload
	if err := json.Unmarshal(msg.data, &p); err != nil {
		return
	}
	m, ok := r.members[msg.from]
	if !ok {
		return
	}
	payload, err := ws.Encode(ws.TypePong, "", ws.PongPayload{
		Nonce:      p.Nonce,
		Members:    len(r.members),
		Evictions:  r.evictions.Load(),
		QueueDepth: m.BufferDepth(),
		QueueCap:   m.BufferCap(),
	})
	if err != nil {
		r.log.Error("encode pong", "err", err)
		return
	}
	if !m.TrySend(payload) {
		r.evictOne(m)
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
			r.evictions.Add(1)
		}
	}
	if len(evicted) > 0 {
		r.size.Store(int32(len(r.members)))
		r.broadcastPresence()
		if len(r.members) == 0 && r.onEmpty != nil {
			r.onEmpty()
		}
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
		r.evictions.Add(1)
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
