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
	TypePresence MessageType = "presence"
	TypeError    MessageType = "error"
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
	X1    float64 `json:"x1"`
	Y1    float64 `json:"y1"`
	X2    float64 `json:"x2"`
	Y2    float64 `json:"y2"`
	Color string  `json:"color"`
	Width float64 `json:"width"`
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
