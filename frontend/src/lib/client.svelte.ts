import type {
	ChatPayload,
	CursorPos,
	Envelope,
	LaserPos,
	MessageType,
	PongPayload,
	PresenceUser,
	RoomMetaPayload,
	SnapshotPayload,
	Stroke,
	StrokeMode,
	StrokeUndoPayload
} from './protocol';

export interface ChatEntry {
	id: number;
	from: string;
	name: string;
	color: string;
	text: string;
	at: number;
}

export interface RemoteCursor {
	x: number;
	y: number;
	lastSeen: number;
	name: string;
	color: string;
}

export interface LaserPoint {
	x: number;
	y: number;
	at: number;
	color: string;
}

// Viewport maps world coordinates to screen pixels:
//   screen = world * scale + (tx, ty)
//   world  = (screen - (tx, ty)) / scale
// Stored on the client so the canvas renderer and the cursor/laser
// overlays can all transform through the same lens. The wire format
// is world coords; each peer applies its own viewport on render.
export interface Viewport {
	tx: number;
	ty: number;
	scale: number;
}

export type Tool = 'pen' | 'eraser' | 'laser';

const RECONNECT_DELAY_MS = 1500;
const CURSOR_THROTTLE_MS = 33; // ~30Hz
const LASER_THROTTLE_MS = 33;
const LASER_TRAIL_TTL_MS = 1500;
const LASER_TRAIL_CAP = 32;
const CHAT_HISTORY_CAP = 200;
const PING_INTERVAL_MS = 2000;
const RTT_EMA_ALPHA = 0.3;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

const PALETTE = [
	'#ef4444',
	'#f59e0b',
	'#eab308',
	'#22c55e',
	'#06b6d4',
	'#3b82f6',
	'#8b5cf6',
	'#ec4899'
];

/**
 * CollabClient owns the WebSocket lifecycle and the reactive state the
 * UI binds to. There is one instance for the whole app (see the export
 * below). Components import it and read state directly via runes.
 *
 * The drawing surface is event-driven, not state-driven: the Whiteboard
 * registers callbacks (onStroke / onSnapshot / onClear) so that incoming
 * strokes paint immediately without rebuilding the canvas from scratch.
 */
export class CollabClient {
	// ==== reactive state ====
	connected = $state(false);
	connecting = $state(false);
	roomCode = $state('');
	roomMeta = $state<RoomMetaPayload | null>(null);
	members = $state<PresenceUser[]>([]);
	chat = $state<ChatEntry[]>([]);
	cursors = $state<Map<string, RemoteCursor>>(new Map());
	// Per-user trail of recent laser pings. Each user's trail is bounded
	// in length so a flood cannot grow memory unbounded — the renderer
	// fades and drops points by age.
	laserTrails = $state<Map<string, LaserPoint[]>>(new Map());

	myName = $state('');
	myColor = $state(PALETTE[5]);

	tool = $state<Tool>('pen');
	color = $state(PALETTE[5]);
	width = $state(3);

	// Undo/redo are local-history per user: each client tracks its own
	// stroke groups. Remote users' undo arrives as `stroke_undo` and is
	// applied to the canvas, but never enters our redo stack — we cannot
	// redo a stroke we did not draw.
	undoDepth = $state(0);
	redoDepth = $state(0);

	// HUD telemetry. Populated by pong replies; rtt is an EMA over the
	// last few RTT samples so transient spikes don't make the readout
	// flicker. Zero values mean "no data yet" — the UI shows "—".
	rttMs = $state(0);
	queueDepth = $state(0);
	queueCap = $state(0);
	evictions = $state(0);
	hudVisible = $state(false);

	// Local infinite-canvas viewport. Identity = pan(0,0), zoom 1×.
	viewport = $state<Viewport>({ tx: 0, ty: 0, scale: 1 });

	// ==== internals ====
	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private cursorTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingCursor: CursorPos | null = null;
	private laserTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingLaser: LaserPos | null = null;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private pingNonce = 0;
	private pingSentAt = new Map<number, number>();
	private chatSeq = 0;
	private chosenRoom = '';
	private currentGroupId: string | null = null;
	private undoStack: string[] = [];
	private redoStack: { groupId: string; strokes: Stroke[] }[] = [];

	// ==== callbacks (registered by the canvas component) ====
	onStroke: ((stroke: Stroke) => void) | null = null;
	onSnapshot: ((strokes: Stroke[]) => void) | null = null;
	onClear: (() => void) | null = null;
	onRemoveGroup: ((groupId: string) => boolean) | null = null;
	onGetGroup: ((groupId: string) => Stroke[]) | null = null;

	get palette(): readonly string[] {
		return PALETTE;
	}

	pickRandomColor(): string {
		const idx = Math.floor(Math.random() * PALETTE.length);
		return PALETTE[idx];
	}

	connect(room: string, name: string, color: string): void {
		this.chosenRoom = room;
		this.roomCode = room;
		this.myName = name;
		this.myColor = color;
		this.color = color;
		this.openSocket();
	}

	disconnect(): void {
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onclose = null;
			ws.close();
		}
		this.connected = false;
		this.connecting = false;
	}

	sendStroke(stroke: Stroke): void {
		this.send('stroke', stroke);
	}

	// beginStrokeGroup is called on pointer-down. It mints a fresh
	// groupId and clears the redo stack — any new drawing invalidates
	// previously-undone strokes (standard text-editor behavior).
	beginStrokeGroup(): string {
		this.currentGroupId = newGroupId();
		if (this.redoStack.length) {
			this.redoStack = [];
			this.redoDepth = 0;
		}
		return this.currentGroupId;
	}

	// endStrokeGroup is called on pointer-up. It pushes the just-drawn
	// group onto the undo stack so Ctrl+Z can pop it.
	endStrokeGroup(): void {
		const id = this.currentGroupId;
		this.currentGroupId = null;
		if (!id) return;
		this.undoStack.push(id);
		this.undoDepth = this.undoStack.length;
	}

	undo(): void {
		const groupId = this.undoStack.pop();
		this.undoDepth = this.undoStack.length;
		if (!groupId) return;
		const strokes = this.onGetGroup?.(groupId) ?? [];
		if (!strokes.length) return;
		this.send('stroke_undo', { groupId } satisfies StrokeUndoPayload);
		this.onRemoveGroup?.(groupId);
		this.redoStack.push({ groupId, strokes });
		this.redoDepth = this.redoStack.length;
	}

	redo(): void {
		const item = this.redoStack.pop();
		this.redoDepth = this.redoStack.length;
		if (!item) return;
		// Re-emit each segment as a fresh stroke message. Server records
		// them again (same groupId) and fans them out to peers, so a
		// future undo of this group still works for everyone.
		for (const s of item.strokes) {
			this.onStroke?.(s);
			this.send('stroke', s);
		}
		this.undoStack.push(item.groupId);
		this.undoDepth = this.undoStack.length;
	}

	sendChat(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.send('chat', { text: trimmed } satisfies ChatPayload);
		this.appendChat({
			from: 'me',
			name: this.myName,
			color: this.myColor,
			text: trimmed
		});
	}

	queueCursor(p: CursorPos): void {
		this.pendingCursor = p;
		if (this.cursorTimer !== undefined) return;
		this.cursorTimer = setTimeout(() => {
			this.cursorTimer = undefined;
			if (this.pendingCursor) {
				this.send('cursor', this.pendingCursor);
				this.pendingCursor = null;
			}
		}, CURSOR_THROTTLE_MS);
	}

	queueLaser(p: LaserPos): void {
		// Local echo first — pointer ping feedback must be instant.
		this.pushLaserPoint('me', p, this.myColor);
		this.pendingLaser = p;
		if (this.laserTimer !== undefined) return;
		this.laserTimer = setTimeout(() => {
			this.laserTimer = undefined;
			if (this.pendingLaser) {
				this.send('laser', this.pendingLaser);
				this.pendingLaser = null;
			}
		}, LASER_THROTTLE_MS);
	}

	pruneLaserTrails(now: number): void {
		let mutated = false;
		for (const [id, trail] of this.laserTrails) {
			const kept = trail.filter((p) => now - p.at <= LASER_TRAIL_TTL_MS);
			if (kept.length !== trail.length) {
				mutated = true;
				if (kept.length === 0) this.laserTrails.delete(id);
				else this.laserTrails.set(id, kept);
			}
		}
		if (mutated) {
			this.laserTrails = new Map(this.laserTrails);
		}
	}

	private pushLaserPoint(from: string, p: LaserPos, color: string): void {
		const now = performance.now();
		const next = new Map(this.laserTrails);
		const trail = next.get(from) ?? [];
		const appended = [...trail, { x: p.x, y: p.y, at: now, color }];
		const trimmed =
			appended.length > LASER_TRAIL_CAP
				? appended.slice(appended.length - LASER_TRAIL_CAP)
				: appended;
		next.set(from, trimmed);
		this.laserTrails = next;
	}

	clearBoard(): void {
		this.send('clear', {});
	}

	// screenToWorld converts a pointer-relative screen position to the
	// world coordinate the wire protocol expects.
	screenToWorld(sx: number, sy: number): { x: number; y: number } {
		const vp = this.viewport;
		return { x: (sx - vp.tx) / vp.scale, y: (sy - vp.ty) / vp.scale };
	}

	panBy(dx: number, dy: number): void {
		const vp = this.viewport;
		this.viewport = { tx: vp.tx + dx, ty: vp.ty + dy, scale: vp.scale };
	}

	// zoomAt scales around a fixed screen pivot. Keeping the world point
	// under the cursor stationary across a zoom is the only thing that
	// makes wheel-zoom feel natural — without it the camera drifts.
	zoomAt(sx: number, sy: number, factor: number): void {
		const vp = this.viewport;
		const next = clamp(vp.scale * factor, MIN_SCALE, MAX_SCALE);
		if (next === vp.scale) return;
		const wx = (sx - vp.tx) / vp.scale;
		const wy = (sy - vp.ty) / vp.scale;
		this.viewport = { tx: sx - wx * next, ty: sy - wy * next, scale: next };
	}

	resetView(): void {
		this.viewport = { tx: 0, ty: 0, scale: 1 };
	}

	private resetUndoRedo(): void {
		this.currentGroupId = null;
		this.undoStack = [];
		this.redoStack = [];
		this.undoDepth = 0;
		this.redoDepth = 0;
	}

	pruneStaleCursors(now: number, ttlMs = 5000): void {
		let mutated = false;
		for (const [id, c] of this.cursors) {
			if (now - c.lastSeen > ttlMs) {
				this.cursors.delete(id);
				mutated = true;
			}
		}
		if (mutated) {
			// nudge reactivity for Map mutations
			this.cursors = new Map(this.cursors);
		}
	}

	makeStroke(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		mode: StrokeMode = 'draw'
	): Stroke {
		return {
			x1,
			y1,
			x2,
			y2,
			color: this.color,
			width: this.width,
			mode,
			groupId: this.currentGroupId ?? undefined
		};
	}

	// ==== private ====

	private openSocket(): void {
		this.connecting = true;
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const params = new URLSearchParams({
			room: this.chosenRoom,
			name: this.myName,
			color: this.myColor
		});
		const url = `${proto}//${location.host}/ws?${params.toString()}`;

		const socket = new WebSocket(url);
		this.ws = socket;

		socket.onopen = () => {
			this.connected = true;
			this.connecting = false;
			this.startPing();
		};
		socket.onclose = () => {
			this.connected = false;
			this.connecting = false;
			this.stopPing();
			this.scheduleReconnect();
		};
		socket.onerror = () => {
			socket.close();
		};
		socket.onmessage = (ev) => this.handleMessage(ev);
	}

	private startPing(): void {
		this.stopPing();
		const fire = () => {
			const nonce = ++this.pingNonce;
			this.pingSentAt.set(nonce, performance.now());
			// Drop stale entries: anything older than 30s never got a pong.
			const cutoff = performance.now() - 30000;
			for (const [k, t] of this.pingSentAt) {
				if (t < cutoff) this.pingSentAt.delete(k);
			}
			this.send('ping', { nonce });
		};
		fire();
		this.pingTimer = setInterval(fire, PING_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer !== undefined) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
		this.pingSentAt.clear();
	}

	private handlePong(p: PongPayload): void {
		const sentAt = this.pingSentAt.get(p.nonce);
		if (sentAt !== undefined) {
			this.pingSentAt.delete(p.nonce);
			const sample = performance.now() - sentAt;
			// EMA smoothing — single noisy spike shouldn't dominate the HUD.
			this.rttMs = this.rttMs === 0
				? sample
				: this.rttMs * (1 - RTT_EMA_ALPHA) + sample * RTT_EMA_ALPHA;
		}
		this.queueDepth = p.queueDepth;
		this.queueCap = p.queueCap;
		this.evictions = p.evictions;
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer !== undefined) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket();
		}, RECONNECT_DELAY_MS);
	}

	private send(type: MessageType, data: unknown): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type, data }));
	}

	private handleMessage(ev: MessageEvent<string>): void {
		let env: Envelope;
		try {
			env = JSON.parse(ev.data) as Envelope;
		} catch {
			return;
		}
		switch (env.type) {
			case 'stroke':
				this.onStroke?.(env.data as Stroke);
				break;
			case 'stroke_undo': {
				const id = (env.data as StrokeUndoPayload | undefined)?.groupId;
				if (id) this.onRemoveGroup?.(id);
				break;
			}
			case 'cursor':
				this.handleCursor(env.from ?? '', env.data as CursorPos);
				break;
			case 'laser': {
				const from = env.from ?? '';
				if (!from) break;
				const member = this.members.find((u) => u.id === from);
				this.pushLaserPoint(from, env.data as LaserPos, member?.color ?? '#ef4444');
				break;
			}
			case 'chat':
				this.handleRemoteChat(env.from ?? '', env.data as ChatPayload);
				break;
			case 'presence':
				this.members = ((env.data as { users?: PresenceUser[] })?.users ?? []) as PresenceUser[];
				break;
			case 'snapshot':
				// A fresh snapshot means our local stroke history may be stale
				// (e.g. we just reconnected). Drop the undo/redo stacks since
				// their group IDs reference strokes we no longer own.
				this.resetUndoRedo();
				this.onSnapshot?.(((env.data as SnapshotPayload | undefined)?.strokes ?? []) as Stroke[]);
				break;
			case 'room_meta':
				this.roomMeta = env.data as RoomMetaPayload;
				break;
			case 'pong':
				this.handlePong(env.data as PongPayload);
				break;
			case 'clear':
				this.resetUndoRedo();
				this.onClear?.();
				break;
			case 'error':
				// surface server-side errors in chat for now — keeps the UI simple
				this.appendChat({
					from: 'system',
					name: 'system',
					color: '#ef4444',
					text: (env.data as { message?: string })?.message ?? 'server error'
				});
				break;
		}
	}

	private handleCursor(from: string, pos: CursorPos): void {
		if (!from) return;
		const member = this.members.find((u) => u.id === from);
		const next = new Map(this.cursors);
		next.set(from, {
			x: pos.x,
			y: pos.y,
			lastSeen: performance.now(),
			name: member?.name ?? '…',
			color: member?.color ?? '#888'
		});
		this.cursors = next;
	}

	private handleRemoteChat(from: string, data: ChatPayload): void {
		const member = this.members.find((u) => u.id === from);
		this.appendChat({
			from,
			name: member?.name ?? 'someone',
			color: member?.color ?? '#888',
			text: data?.text ?? ''
		});
	}

	private appendChat(entry: Omit<ChatEntry, 'id' | 'at'>): void {
		this.chatSeq += 1;
		const next: ChatEntry = {
			id: this.chatSeq,
			at: Date.now(),
			...entry
		};
		const list = this.chat.length >= CHAT_HISTORY_CAP ? this.chat.slice(-CHAT_HISTORY_CAP + 1) : this.chat;
		this.chat = [...list, next];
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function newGroupId(): string {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	const buf = new Uint8Array(16);
	c?.getRandomValues?.(buf);
	let out = '';
	for (let i = 0; i < buf.length; i++) {
		out += buf[i].toString(16).padStart(2, '0');
	}
	return out || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const client = new CollabClient();
