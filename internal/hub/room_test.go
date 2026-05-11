package hub

import (
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Isidorsson/collab-board/internal/ws"
)

// fakeMember is a deterministic Member for room tests. TrySend pushes
// onto a buffered channel so tests can assert on delivered payloads
// without sleeping. If accept is false, TrySend returns false to
// simulate a slow client whose buffer is full.
type fakeMember struct {
	id     string
	name   string
	color  string
	out    chan []byte
	accept atomic.Bool
	closed atomic.Bool

	mu       sync.Mutex
	closedCh chan struct{}
}

func newFakeMember(id string) *fakeMember {
	m := &fakeMember{
		id:       id,
		name:     id,
		color:    "#000",
		out:      make(chan []byte, 16),
		closedCh: make(chan struct{}),
	}
	m.accept.Store(true)
	return m
}

func (m *fakeMember) ID() string       { return m.id }
func (m *fakeMember) Name() string     { return m.name }
func (m *fakeMember) Color() string    { return m.color }
func (m *fakeMember) BufferDepth() int { return len(m.out) }
func (m *fakeMember) BufferCap() int   { return cap(m.out) }

func (m *fakeMember) TrySend(payload []byte) bool {
	if !m.accept.Load() {
		return false
	}
	select {
	case m.out <- payload:
		return true
	default:
		return false
	}
}

func (m *fakeMember) Close() {
	if m.closed.CompareAndSwap(false, true) {
		m.mu.Lock()
		close(m.closedCh)
		m.mu.Unlock()
	}
}

// next returns the next payload or fails the test on timeout.
func (m *fakeMember) next(t *testing.T) ws.Envelope {
	t.Helper()
	select {
	case raw := <-m.out:
		var env ws.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		return env
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for payload")
		return ws.Envelope{}
	}
}

// nextOfType drains payloads until one of the requested type arrives,
// or fails on timeout. Useful when presence broadcasts arrive between
// the events the test cares about.
func (m *fakeMember) nextOfType(t *testing.T, want ws.MessageType) ws.Envelope {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case raw := <-m.out:
			var env ws.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if env.Type == want {
				return env
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", want)
		}
	}
}

func (m *fakeMember) waitClosed(t *testing.T) {
	t.Helper()
	select {
	case <-m.closedCh:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Close")
	}
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// waitForSize spins until r.Size() == want or the deadline elapses.
// Necessary because Room.run() processes events asynchronously.
func waitForSize(t *testing.T, r *Room, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if r.Size() == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("size never reached %d (last %d)", want, r.Size())
}

func TestRoomBroadcastsToOthers(t *testing.T) {
	r := newRoom("ABC", quietLogger(), nil)
	defer r.close()

	a := newFakeMember("a")
	b := newFakeMember("b")
	r.Join(a)
	r.Join(b)
	waitForSize(t, r, 2)

	// drain the presence broadcasts triggered by joins
	a.nextOfType(t, ws.TypePresence)
	a.nextOfType(t, ws.TypePresence)
	b.nextOfType(t, ws.TypePresence)

	r.Send("a", ws.TypeStroke, []byte(`{"x1":0,"y1":0}`))

	got := b.nextOfType(t, ws.TypeStroke)
	if got.From != "a" {
		t.Errorf("from = %q, want %q", got.From, "a")
	}
}

func TestRoomDoesNotEchoToSender(t *testing.T) {
	r := newRoom("ABC", quietLogger(), nil)
	defer r.close()

	a := newFakeMember("a")
	r.Join(a)
	waitForSize(t, r, 1)
	a.nextOfType(t, ws.TypePresence)

	r.Send("a", ws.TypeStroke, []byte(`{}`))

	select {
	case raw := <-a.out:
		t.Fatalf("sender received its own message: %s", raw)
	case <-time.After(50 * time.Millisecond):
		// expected: nothing arrived
	}
}

func TestRoomEvictsSlowClient(t *testing.T) {
	r := newRoom("ABC", quietLogger(), nil)
	defer r.close()

	fast := newFakeMember("fast")
	slow := newFakeMember("slow")
	r.Join(fast)
	r.Join(slow)
	waitForSize(t, r, 2)

	// drain presence broadcasts triggered by joins. fast was alone for
	// its own join (1 msg) and present for slow's join (2nd msg). slow
	// only saw the broadcast after its own join (1 msg).
	fast.nextOfType(t, ws.TypePresence)
	fast.nextOfType(t, ws.TypePresence)
	slow.nextOfType(t, ws.TypePresence)

	// flip the slow client to refuse all sends, then broadcast
	slow.accept.Store(false)
	r.Send("fast", ws.TypeStroke, []byte(`{}`))

	slow.waitClosed(t)
	waitForSize(t, r, 1)
	if got := r.Size(); got != 1 {
		t.Errorf("size after eviction = %d, want 1", got)
	}
}

func TestRoomFiresOnEmptyAfterLastLeave(t *testing.T) {
	var fired atomic.Int32
	r := newRoom("ABC", quietLogger(), func() { fired.Add(1) })
	defer r.close()

	a := newFakeMember("a")
	r.Join(a)
	waitForSize(t, r, 1)

	r.Leave("a")
	waitForSize(t, r, 0)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if fired.Load() == 1 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("onEmpty never fired (count=%d)", fired.Load())
}

func TestHubEvictsEmptyRoom(t *testing.T) {
	h := New(quietLogger())
	r := h.GetOrCreate("ABC")

	a := newFakeMember("a")
	r.Join(a)
	waitForSize(t, r, 1)

	r.Leave("a")

	// Wait for Hub.removeIfEmpty to run on the room's run goroutine and
	// reflect in Stats().
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		rooms, _ := h.Stats()
		if rooms == 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	rooms, _ := h.Stats()
	t.Fatalf("rooms after last leave = %d, want 0", rooms)
}

func TestHubRemoveIfEmptyRespectsOccupancy(t *testing.T) {
	// removeIfEmpty must re-check Size() under the registry lock. If
	// any member is present (e.g. a join landed between onEmpty firing
	// and removeIfEmpty acquiring the lock) the room must stay alive.
	h := New(quietLogger())
	r := h.GetOrCreate("ABC")

	a := newFakeMember("a")
	r.Join(a)
	waitForSize(t, r, 1)

	h.removeIfEmpty("ABC")

	if rooms, _ := h.Stats(); rooms != 1 {
		t.Fatalf("rooms = %d, want 1 (occupied room must not be evicted)", rooms)
	}
}
