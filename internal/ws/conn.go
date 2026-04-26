package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	sendBufferSize = 64
	pingInterval   = 30 * time.Second
	writeTimeout   = 10 * time.Second
	maxMessageSize = 64 * 1024
)

type RoomBus interface {
	Send(from string, t MessageType, data []byte)
	Leave(id string)
}

type Conn struct {
	id    string
	name  string
	color string

	ws   *websocket.Conn
	send chan []byte

	closeOnce sync.Once
	closed    chan struct{}
	log       *slog.Logger
}

func NewConn(c *websocket.Conn, name, color string, log *slog.Logger) *Conn {
	c.SetReadLimit(maxMessageSize)
	return &Conn{
		id:     newID(),
		name:   name,
		color:  color,
		ws:     c,
		send:   make(chan []byte, sendBufferSize),
		closed: make(chan struct{}),
		log:    log,
	}
}

func (c *Conn) ID() string    { return c.id }
func (c *Conn) Name() string  { return c.name }
func (c *Conn) Color() string { return c.color }

func (c *Conn) TrySend(payload []byte) bool {
	select {
	case <-c.closed:
		return false
	case c.send <- payload:
		return true
	default:
		return false
	}
}

func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	})
}

// Run drives the read and write pumps and blocks until either exits.
// On exit, the connection is closed and the room is told the member has left.
func (c *Conn) Run(ctx context.Context, room RoomBus) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer c.Close()
	defer room.Leave(c.id)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); defer cancel(); c.readPump(ctx, room) }()
	go func() { defer wg.Done(); defer cancel(); c.writePump(ctx) }()
	wg.Wait()
}

func (c *Conn) readPump(ctx context.Context, room RoomBus) {
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			c.log.Debug("read pump exit", "id", c.id, "err", err)
			return
		}
		env, err := Decode(data)
		if err != nil {
			c.log.Debug("decode failed", "id", c.id, "err", err)
			continue
		}
		switch env.Type {
		case TypeStroke, TypeCursor, TypeChat:
			room.Send(c.id, env.Type, env.Data)
		default:
			// Ignore unknown types silently — keeps protocol forward-compatible.
		}
	}
}

func (c *Conn) writePump(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case msg := <-c.send:
			wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageText, msg)
			wcancel()
			if err != nil {
				c.log.Debug("write pump exit on write", "id", c.id, "err", err)
				return
			}
		case <-ticker.C:
			pctx, pcancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pctx)
			pcancel()
			if err != nil {
				c.log.Debug("ping failed, closing", "id", c.id, "err", err)
				return
			}
		}
	}
}

func newID() string {
	var b [8]byte
	// crypto/rand.Read on Linux/macOS/Windows is documented never to
	// return an error; if it ever did we'd produce an all-zero ID,
	// which is harmless for an in-memory presence key.
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
