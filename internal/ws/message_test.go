package ws

import (
	"encoding/json"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		typ  MessageType
		from string
		data any
	}{
		{"stroke", TypeStroke, "abc", StrokePayload{X1: 1, Y1: 2, X2: 3, Y2: 4, Color: "#fff", Width: 2}},
		{"cursor", TypeCursor, "def", CursorPayload{X: 100.5, Y: 200.25}},
		{"chat", TypeChat, "ghi", ChatPayload{Text: "hello"}},
		{"presence empty", TypePresence, "", PresencePayload{Users: []PresenceUser{}}},
		{"presence two", TypePresence, "", PresencePayload{Users: []PresenceUser{
			{ID: "1", Name: "alice", Color: "#f00"},
			{ID: "2", Name: "bob", Color: "#0f0"},
		}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := Encode(tc.typ, tc.from, tc.data)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			env, err := Decode(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if env.Type != tc.typ {
				t.Errorf("type mismatch: got %q want %q", env.Type, tc.typ)
			}
			if env.From != tc.from {
				t.Errorf("from mismatch: got %q want %q", env.From, tc.from)
			}
			// Spot-check that the inner payload survived.
			expected, _ := json.Marshal(tc.data)
			if string(env.Data) != string(expected) {
				t.Errorf("payload mismatch:\n got %s\nwant %s", env.Data, expected)
			}
		})
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	if _, err := Decode([]byte("not json")); err == nil {
		t.Error("expected decode error for non-JSON input")
	}
}
