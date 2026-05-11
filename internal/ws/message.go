package ws

import (
	"encoding/json"
	"fmt"
)

type MessageType string

const (
	TypeJoin       MessageType = "join"
	TypeStroke     MessageType = "stroke"
	TypeStrokeUndo MessageType = "stroke_undo"
	TypeCursor     MessageType = "cursor"
	TypeLaser      MessageType = "laser"
	TypeText       MessageType = "text"
	TypeTextDelete MessageType = "text_delete"
	TypeChat       MessageType = "chat"
	TypeClear      MessageType = "clear"
	TypePresence   MessageType = "presence"
	TypeSnapshot   MessageType = "snapshot"
	TypeRoomMeta   MessageType = "room_meta"
	TypePing       MessageType = "ping"
	TypePong       MessageType = "pong"
	TypeViewport   MessageType = "viewport"
	TypeError      MessageType = "error"
)

// StrokeMode distinguishes draw and erase strokes on the wire.
// An empty string is treated as "draw" so older clients keep working.
type StrokeMode string

const (
	StrokeModeDraw  StrokeMode = "draw"
	StrokeModeErase StrokeMode = "erase"
)

type Envelope struct {
	Type MessageType     `json:"type"`
	From string          `json:"from,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

type JoinPayload struct {
	Room  string `json:"room"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type StrokePayload struct {
	X1      float64    `json:"x1"`
	Y1      float64    `json:"y1"`
	X2      float64    `json:"x2"`
	Y2      float64    `json:"y2"`
	Color   string     `json:"color"`
	Width   float64    `json:"width"`
	Mode    StrokeMode `json:"mode,omitempty"`
	GroupID string     `json:"groupId,omitempty"`
}

// StrokeUndoPayload identifies a stroke group to remove from history.
// GroupID matches StrokePayload.GroupID; empty IDs are ignored so a
// malformed undo cannot wipe ungrouped (legacy) strokes.
type StrokeUndoPayload struct {
	GroupID string `json:"groupId"`
}

type CursorPayload struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// LaserPayload is an ephemeral pointer ping. Clients render it as a
// short-lived fading trail; nothing is recorded server-side.
type LaserPayload struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type ChatPayload struct {
	Text string `json:"text"`
}

type PresenceUser struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type PresencePayload struct {
	Users []PresenceUser `json:"users"`
}

// SnapshotPayload is sent to a member right after they join, so they
// see the board's current strokes and text boxes instead of an empty
// canvas. Both lists are bounded; nothing is persisted.
type SnapshotPayload struct {
	Strokes []StrokePayload `json:"strokes"`
	Texts   []TextPayload   `json:"texts"`
}

// TextPayload represents a single text box on the board. ID is a
// client-minted UUID so updates can be addressed without a server
// round trip. GroupID lets a text participate in the same undo system
// as strokes -- a Ctrl+Z that targets a group will remove the text.
type TextPayload struct {
	ID      string  `json:"id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Text    string  `json:"text"`
	Color   string  `json:"color"`
	Size    float64 `json:"size"`
	GroupID string  `json:"groupId,omitempty"`
}

// TextDeletePayload removes a text box by ID. Used by the owner on
// explicit delete; the undo path uses StrokeUndoPayload with the same
// GroupID since one group can span strokes and texts.
type TextDeletePayload struct {
	ID string `json:"id"`
}

// RoomMetaPayload exposes room-level facts to the client (room code,
// when the room was first opened, advisory member capacity). It is
// sent once on join and never persisted.
type RoomMetaPayload struct {
	Code      string `json:"code"`
	CreatedAt int64  `json:"createdAt"` // unix milliseconds
	Capacity  int    `json:"capacity"`
}

// ViewportPayload broadcasts a sender's current camera. CX/CY are the
// world coordinates currently centered on the sender's screen; Scale
// is their zoom factor. Followers re-derive their own translation so
// the same world point sits in the center of their viewport regardless
// of screen size -- transmitting raw tx/ty would not survive a screen
// size mismatch.
type ViewportPayload struct {
	CX    float64 `json:"cx"`
	CY    float64 `json:"cy"`
	Scale float64 `json:"scale"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}

// PingPayload is the client-originated half of an application-level
// heartbeat. The server echoes the nonce back in PongPayload so the
// client can measure round-trip latency end-to-end (not just at the
// TCP/WS layer, which the websocket library hides).
type PingPayload struct {
	Nonce int64 `json:"nonce"`
}

// PongPayload carries the echoed nonce plus a small slice of room-side
// telemetry. We piggy-back stats on pong rather than firing a separate
// stats broadcast so the HUD updates at exactly the ping cadence.
type PongPayload struct {
	Nonce      int64 `json:"nonce"`
	Members    int   `json:"members"`
	Evictions  int64 `json:"evictions"`
	QueueDepth int   `json:"queueDepth"`
	QueueCap   int   `json:"queueCap"`
}

func Encode(t MessageType, from string, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("encode payload: %w", err)
	}
	return json.Marshal(Envelope{Type: t, From: from, Data: raw})
}

func Decode(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, fmt.Errorf("decode envelope: %w", err)
	}
	return env, nil
}
