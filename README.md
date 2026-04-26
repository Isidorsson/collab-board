# collab-board

A real-time collaborative whiteboard server in Go. WebSocket-based, single
binary, no database, no framework. Drop into a room code, draw, see other
people's strokes and cursors live, chat with them.

Built as a weekend MVP to demonstrate Go concurrency patterns end to end —
the *interesting* parts of a real-time backend, without the algorithmic
detour of CRDTs/OT.

## Quick start

```bash
make run
# open two browser windows at http://localhost:8080
# put the same room code in both, draw in one, watch the other
```

Or with Docker:

```bash
make docker docker-run
```

## What's interesting in here

The single design decision I'd ask you to read:

### Backpressure: drop slow clients, never stall the room

Each connection has a **bounded outbound buffer** (64 messages). The room
goroutine fans out broadcasts via a *non-blocking* `TrySend`:

```go
// internal/hub/room.go
for id, m := range r.members {
    if id == msg.from { continue }
    if !m.TrySend(payload) {
        evicted = append(evicted, id) // slow client — boot them
    }
}
```

This is the line that separates a toy real-time server from one that
survives the wild. The naive version uses a blocking send; one slow
client (mobile on bad wifi, paused tab, deliberately misbehaving) then
freezes the entire room. Bounded buffer + non-blocking send + eviction
makes the room's broadcast latency a function of the *fastest* members,
not the slowest.

The trade-off: the slow client misses messages and is disconnected. For
a whiteboard that's fine — they reconnect and start fresh. For something
like a text editor you'd need durable per-client queues plus
resync-on-reconnect.

### Goroutine ownership of room state

The room's member map is owned by exactly one goroutine — the one
running `Room.run()`. All mutations happen there, in response to
channel events (`join`, `leave`, `inbound`). No mutex on the map. The
hub talks to rooms by sending on channels.

The only piece of room state that *is* exposed across goroutines is
`size` (an `atomic.Int32`), used by the metrics endpoint. That single
exception is documented at the type level — the rule is otherwise
"channels in, broadcasts out, no shared memory."

### Read pump and write pump are separate goroutines

Standard pattern but worth naming: a single `Conn` runs **two
goroutines** — one blocked on `Read`, one blocked on `select` over the
send channel. They share nothing except the underlying socket and a
cancellable context. Either dying triggers the cancel, which kills the
other within one operation. The write pump owns ping-emission so we
never have two goroutines writing to the socket simultaneously.

## Architecture

```
Browser  ─── WebSocket ───▶  /ws?room=ABCD&name=alice
                              │
                              ▼
                          ┌────────┐         ┌──────────┐
                          │  Conn  │ ───────▶│   Room   │
                          │ (read) │         │goroutine │ ───▶ broadcast
                          └────────┘         └──────────┘      to all conns
                              │                   ▲
                              ▼                   │
                          ┌────────┐              │
                          │  Conn  │ ◀────────────┘
                          │(write) │  bounded send channel (cap=64)
                          └────────┘
```

## Wire protocol

JSON envelopes over text frames. Six message types:

| Direction | Type      | Payload                                      |
|-----------|-----------|----------------------------------------------|
| C → S     | `join`    | reserved (currently set via query string)    |
| C ↔ S     | `stroke`  | `{x1, y1, x2, y2, color, width}`             |
| C ↔ S     | `cursor`  | `{x, y}`                                     |
| C ↔ S     | `chat`    | `{text}`                                     |
| S → C     | `presence`| `{users: [{id, name, color}]}`               |
| S → C     | `error`   | `{message}`                                  |

Server stamps every broadcast with `from: <userID>` so clients can
ignore their own echoes.

## Endpoints

- `GET /` — bundled web client (HTML/JS/CSS via `embed.FS`)
- `GET /ws?room=ABCD&name=alice&color=%23ff0000` — WebSocket upgrade
- `GET /healthz` — liveness probe
- `GET /metrics` — Prometheus exposition (rooms_active, members_active)

## Load test

A bundled load generator opens N concurrent clients into one room and
streams cursor messages.

```bash
# 200 clients, 50ms cursor interval, 30s test
make loadtest

# Same, but client #0 deliberately stops reading.
# Watch the server log evict it; remaining 49 stay healthy.
make loadtest-slow
```

The slow-client run is the demo of the backpressure design choice — the
server log emits `evicting slow client` while the other 49 clients
continue trading messages without slowdown.

## Deliberate non-goals

- **No persistence.** Refresh = empty board. Strokes are ephemeral.
- **No auth.** Anyone with a room code joins.
- **No horizontal scaling.** Single instance. v2 = Redis pub/sub bridge.
- **No CRDTs / OT.** Whiteboard strokes don't need merge resolution.

## Layout

```
collab-board/
├── cmd/server/main.go          # entrypoint, embed.FS for /web
├── cmd/server/web/             # bundled frontend (HTML/JS/CSS)
├── cmd/loadtest/main.go        # concurrent client generator
├── internal/hub/
│   ├── hub.go                  # room registry
│   └── room.go                 # per-room goroutine, fan-out, eviction
├── internal/ws/
│   ├── conn.go                 # read/write pumps, bounded send channel
│   └── message.go              # wire protocol types
├── internal/handlers/
│   ├── ws.go                   # /ws upgrade handler
│   └── health.go               # /healthz, /metrics
├── Dockerfile                  # multi-stage → distroless
├── Makefile
└── go.mod                      # one third-party dep: coder/websocket
```

## Dependencies

- `github.com/coder/websocket` (formerly `nhooyr.io/websocket`)

That's it. Everything else is the standard library — `net/http`,
`log/slog`, `embed`, `context`, `sync/atomic`.
