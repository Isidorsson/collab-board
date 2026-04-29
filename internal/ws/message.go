package ws

import (
	"encoding/json"
	"fmt"
)

type MessageType string

const (
	TypeJoin     MessageType = "join"
	TypeStroke   MessageType = "stroke"
	TypeCursor   MessageType = "cursor"
	TypeChat     MessageType = "chat"
	TypeClear    MessageType = "clear"
	TypePresence MessageType = "presence"
	TypeSnapshot MessageType = "snapshot"
	TypeRoomMeta MessageType = "room_meta"
	TypeError    MessageType = "error"
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
	X1    float64    `json:"x1"`
	Y1    float64    `json:"y1"`
	X2    float64    `json:"x2"`
	Y2    float64    `json:"y2"`
	Color string     `json:"color"`
	Width float64    `json:"width"`
	Mode  StrokeMode `json:"mode,omitempty"`
}

type CursorPayload struct {
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
// see the board's current strokes instead of an empty canvas. The
// history is bounded by Room.maxHistory; it is not a persisted log.
type SnapshotPayload struct {
	Strokes []StrokePayload `json:"strokes"`
}

// RoomMetaPayload exposes room-level facts to the client (room code,
// when the room was first opened, advisory member capacity). It is
// sent once on join and never persisted.
type RoomMetaPayload struct {
	Code      string `json:"code"`
	CreatedAt int64  `json:"createdAt"` // unix milliseconds
	Capacity  int    `json:"capacity"`
}

type ErrorPayload struct {
	Message string `json:"message"`
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
