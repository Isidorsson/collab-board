# collab-board

A real-time collaborative whiteboard. Go on the back, Svelte 5 on the
front, both shipping as one binary. Drop into a room code, draw with
pen or eraser, see the room's cursors move live, chat, share an invite
link. Late joiners get a snapshot of the board so far.

The frontend and backend live together because they earn it together —
there is one design that runs from a pointer event in the browser to a
broadcast across goroutines on the server, and back. Reading the whole
thing is the point.

## Quick start

```bash
make build && ./bin/collab-board
# open two browser windows at http://localhost:8080
# put the same room code in both, draw in one, watch the other
```

For HMR-driven UI work:

```bash
make dev
# Vite on http://localhost:5173 (proxies /ws to the Go server)
# Go on http://localhost:8080
```

Or with Docker:

```bash
make docker docker-run
```

## What's interesting in here

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
a whiteboard that's fine — they reconnect and get a fresh snapshot from
the server. For something like a text editor you'd need durable
per-client queues plus resync-on-reconnect.

### Goroutine ownership of room state

The room's member map and stroke history are owned by exactly one
goroutine — the one running `Room.run()`. All mutations happen there,
in response to channel events (`join`, `leave`, `inbound`). No mutex
on the map, no mutex on the history. The hub talks to rooms by sending
on channels.

The only piece of room state that *is* exposed across goroutines is
`size` (an `atomic.Int32`), used by the metrics endpoint. That single
exception is documented at the type level — the rule is otherwise
"channels in, broadcasts out, no shared memory."

### Read pump and write pump are separate goroutines

A single `Conn` runs **two goroutines** — one blocked on `Read`, one
blocked on `select` over the send channel. They share nothing except
the underlying socket and a cancellable context. Either dying triggers
the cancel, which kills the other within one operation. The write pump
owns ping-emission so we never have two goroutines writing to the
socket simultaneously.

### Snapshots for late joiners

The room holds a bounded ring of strokes (cap 2000). When someone
joins, the room goroutine sends them a `snapshot` envelope before any
new broadcasts — so they walk into a room that already has art on the
walls, not an empty canvas. When the buffer overflows, the oldest
strokes drop. This stays in-memory; the README is still emphatic
about "no persistence" — refresh the last tab in a room and the
strokes are gone forever.

## Frontend

The UI is a Svelte 5 SPA in `frontend/`, compiled by Vite into
`cmd/server/web/dist/` and embedded into the Go binary via
`//go:embed all:web/dist`. There is no separate frontend deploy.

- **Svelte 5 with runes mode** — all reactive state lives in classes
  exported from `*.svelte.ts` modules (`client.svelte.ts`,
  `theme.svelte.ts`); components read state directly via runes.
- **Pointer events** for drawing, so touch and stylus work alongside
  mouse without a second code path.
- **Eraser** uses canvas `destination-out` compositing — no vector
  bookkeeping needed; just remove pixels.
- **Replay buffer** in the canvas controller so window resize and
  late-join snapshots both rebuild the raster from the same list.
- **No state framework, no router, no UI library**. Total client
  bundle: ~9 KB JS / ~4 KB CSS gzipped.

## Architecture

```
Browser  ─── WebSocket ───▶  /ws?room=ABCD&name=alice
                              │
                              ▼
                          ┌────────┐         ┌──────────┐
                          │  Conn  │ ───────▶│   Room   │
                          │ (read) │         │goroutine │ ───▶ broadcast
                          └────────┘         │ + history│      to all conns
                              │              └──────────┘
                              ▼                   ▲
                          ┌────────┐              │
                          │  Conn  │ ◀────────────┘
                          │(write) │  bounded send channel (cap=64)
                          └────────┘
```

## Wire protocol

JSON envelopes over text frames. All payloads are documented in
`internal/ws/message.go`. The TS mirror is `frontend/src/lib/protocol.ts`.

| Direction | Type        | Payload                                    | Notes                                |
|-----------|-------------|--------------------------------------------|--------------------------------------|
| C → S     | `join`      | reserved (set via query string)            |                                      |
| C ↔ S     | `stroke`    | `{x1,y1,x2,y2,color,width,mode?}`          | `mode: "draw"\|"erase"` (optional)    |
| C ↔ S     | `cursor`    | `{x,y}`                                    |                                      |
| C ↔ S     | `chat`      | `{text}`                                   |                                      |
| C ↔ S     | `clear`     | `{}`                                       | broadcast to **all**, sender included |
| S → C     | `presence`  | `{users: [{id,name,color}]}`               |                                      |
| S → C     | `snapshot`  | `{strokes: [Stroke,...]}`                  | sent once on join, before any others |
| S → C     | `room_meta` | `{code,createdAt,capacity}`                | sent once on join                    |
| S → C     | `error`     | `{message}`                                |                                      |

Server stamps every fan-out with `from: <userID>` so clients can
suppress their own echoes.

## Endpoints

- `GET /` — Svelte SPA (built into `cmd/server/web/dist/` via `//go:embed`)
- `GET /ws?room=ABCD&name=alice&color=%23ff0000` — WebSocket upgrade
- `GET /healthz` — liveness probe
- `GET /metrics` — Prometheus exposition (`rooms_active`, `members_active`)

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

- **No persistence.** Strokes are kept in memory only; closing the last
  tab in a room drops them.
- **No auth.** Anyone with a room code joins.
- **No horizontal scaling.** Single instance. v2 = Redis pub/sub bridge.
- **No CRDTs / OT.** Whiteboard strokes don't need merge resolution.

## Layout

```
collab-board/
├── cmd/server/main.go          # entrypoint, embed.FS for web/dist
├── cmd/server/web/dist/        # built frontend (gitignored except .gitkeep)
├── cmd/loadtest/main.go        # concurrent client generator
├── frontend/                   # Svelte 5 + Vite + TypeScript SPA
│   ├── src/
│   │   ├── App.svelte
│   │   ├── components/         # Whiteboard, ToolPalette, ChatDrawer, ...
│   │   └── lib/                # client.svelte.ts, canvas.ts, protocol.ts
│   ├── public/favicon.svg
│   ├── vite.config.ts          # outDir: '../cmd/server/web/dist'
│   └── package.json
├── internal/hub/
│   ├── hub.go                  # room registry
│   └── room.go                 # per-room goroutine, fan-out, history, eviction
├── internal/ws/
│   ├── conn.go                 # read/write pumps, bounded send channel
│   └── message.go              # wire protocol types
├── internal/handlers/
│   ├── ws.go                   # /ws upgrade handler
│   └── health.go               # /healthz, /metrics
├── Dockerfile                  # node frontend stage → Go build → distroless
├── Makefile
└── go.mod                      # one third-party dep: coder/websocket
```

## Dependencies

- `github.com/coder/websocket` — Go-side WebSocket library
- `svelte`, `vite`, `typescript`, `@sveltejs/vite-plugin-svelte` — frontend toolchain only

The runtime binary has exactly one third-party dependency
(`coder/websocket`); everything else server-side is the standard
library — `net/http`, `log/slog`, `embed`, `context`, `sync/atomic`.
