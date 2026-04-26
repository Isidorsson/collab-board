// Loadtest opens N concurrent WebSocket clients against collab-board and
// streams cursor messages at a steady rate. Optionally one client is a
// "slow" client that never drains its read buffer — used to demonstrate
// the server's backpressure eviction behavior.
//
// Usage:
//
//	go run ./cmd/loadtest -addr ws://localhost:8080/ws -n 200 -room load -dur 30s
//	go run ./cmd/loadtest -addr ws://localhost:8080/ws -n 50 -slow -room load
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

func main() {
	addr := flag.String("addr", "ws://localhost:8080/ws", "websocket endpoint")
	n := flag.Int("n", 100, "number of clients")
	room := flag.String("room", "load", "room code")
	rate := flag.Duration("rate", 50*time.Millisecond, "per-client cursor send interval")
	dur := flag.Duration("dur", 30*time.Second, "test duration")
	slow := flag.Bool("slow", false, "make one client never read (tests eviction)")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *dur)
	defer cancel()

	var sent, recv, dropped atomic.Int64
	var wg sync.WaitGroup

	for i := 0; i < *n; i++ {
		wg.Add(1)
		isSlow := *slow && i == 0
		go func(id int, slowClient bool) {
			defer wg.Done()
			runClient(ctx, *addr, *room, id, *rate, slowClient, &sent, &recv, &dropped)
		}(i, isSlow)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	start := time.Now()
	for {
		select {
		case <-done:
			fmt.Printf("\nfinal: sent=%d recv=%d dropped=%d elapsed=%s\n", sent.Load(), recv.Load(), dropped.Load(), time.Since(start).Round(time.Millisecond))
			return
		case <-t.C:
			fmt.Printf("t+%4ds  sent=%d recv=%d dropped=%d\n", int(time.Since(start).Seconds()), sent.Load(), recv.Load(), dropped.Load())
		}
	}
}

func runClient(ctx context.Context, addr, room string, id int, rate time.Duration, slow bool, sent, recv, dropped *atomic.Int64) {
	u, err := url.Parse(addr)
	if err != nil {
		dropped.Add(1)
		return
	}
	q := u.Query()
	q.Set("room", room)
	q.Set("name", "bot-"+strconv.Itoa(id))
	q.Set("color", "#888")
	u.RawQuery = q.Encode()

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	c, _, err := websocket.Dial(dialCtx, u.String(), nil)
	cancel()
	if err != nil {
		dropped.Add(1)
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	c.SetReadLimit(1 << 20)

	if !slow {
		go func() {
			for {
				_, _, err := c.Read(ctx)
				if err != nil {
					return
				}
				recv.Add(1)
			}
		}()
	}

	t := time.NewTicker(rate)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			x := float64((id*7 + int(time.Now().UnixMilli()/100)) % 1000)
			y := float64((id*13 + int(time.Now().UnixMilli()/100)) % 800)
			payload, _ := json.Marshal(map[string]any{
				"type": "cursor",
				"data": map[string]float64{"x": x, "y": y},
			})
			wctx, wcancel := context.WithTimeout(ctx, 2*time.Second)
			err := c.Write(wctx, websocket.MessageText, payload)
			wcancel()
			if err != nil {
				dropped.Add(1)
				return
			}
			sent.Add(1)
		}
	}
}
