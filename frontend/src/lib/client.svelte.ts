import { SvelteMap } from 'svelte/reactivity';
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
	StrokeUndoPayload,
	TextBox,
	TextDeletePayload,
	ViewportShare
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

export type Tool = 'pen' | 'eraser' | 'laser' | 'text';

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
const VIEWPORT_SHARE_INTERVAL_MS = 80;
const TEXT_SEND_INTERVAL_MS = 120;
const TEXT_TYPING_TTL_MS = 1800;

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
	memberById = $derived(new Map(this.members.map((m) => [m.id, m])));
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

	// Most recently received viewport for each peer. Used to render the
	// follow-user feature: clicking an avatar locks our viewport onto
	// theirs every time they pan or zoom.
	peerViewports = $state<Map<string, ViewportShare>>(new Map());
	followingId = $state<string | null>(null);

	// SvelteMap (not $state<Map>) so per-key set/delete fires reactivity
	// without rebuilding the whole map.
	texts = new SvelteMap<string, TextBox>();
	textOwners = new SvelteMap<string, string>();
	textActivity = new SvelteMap<string, number>();
	editingTextId = $state<string | null>(null);

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
	private viewportShareTimer: ReturnType<typeof setTimeout> | undefined;
	private viewportShareDirty = false;
	private suppressBreakFollow = false;
	// Per-id timers so two boxes being edited at once don't starve each other.
	private textSendTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private textPending = new Map<string, TextBox>();
	private chatSeq = 0;
	private chosenRoom = '';
	private currentGroupId: string | null = null;
	private undoStack: string[] = [];
	private redoStack: { groupId: string; strokes: Stroke[]; texts: TextBox[] }[] = [];

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
		const texts: TextBox[] = [];
		for (const t of this.texts.values()) {
			if (t.groupId === groupId) texts.push(t);
		}
		if (strokes.length === 0 && texts.length === 0) return;
		this.send('stroke_undo', { groupId } satisfies StrokeUndoPayload);
		this.onRemoveGroup?.(groupId);
		for (const t of texts) this.forgetText(t.id);
		this.redoStack.push({ groupId, strokes, texts });
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
		for (const t of item.texts) {
			this.texts.set(t.id, t);
			this.textOwners.set(t.id, 'me');
			this.send('text', t);
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

	// A '?' owner (loaded from snapshot, unknown origin) is treated as
	// not-ours so we don't hijack someone else's edits after a reconnect.
	isTextOwnedByMe(id: string): boolean {
		return this.textOwners.get(id) === 'me';
	}

	isTextRecentlyActive(id: string, now: number): boolean {
		const last = this.textActivity.get(id);
		return last !== undefined && now - last < TEXT_TYPING_TTL_MS;
	}

	hasRecentTextActivity(now: number): boolean {
		for (const at of this.textActivity.values()) {
			if (now - at < TEXT_TYPING_TTL_MS) return true;
		}
		return false;
	}

	pruneTextActivity(now: number): void {
		for (const [id, at] of this.textActivity) {
			if (now - at >= TEXT_TYPING_TTL_MS) this.textActivity.delete(id);
		}
	}

	textTypistName(id: string): string {
		const owner = this.textOwners.get(id);
		if (!owner || owner === 'me' || owner === '?') return '';
		return this.memberById.get(owner)?.name ?? '';
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

	// The empty initial box isn't broadcast — first updateText publishes it,
	// so a click-then-click-away leaves no trace on peers.
	createText(x: number, y: number): void {
		const id = newGroupId();
		const groupId = newGroupId();
		const box: TextBox = {
			id,
			x,
			y,
			text: '',
			color: this.color,
			size: widthToFontSize(this.width),
			groupId
		};
		this.texts.set(id, box);
		this.textOwners.set(id, 'me');
		this.editingTextId = id;
		this.redoStack = [];
		this.redoDepth = 0;
		this.undoStack.push(groupId);
		this.undoDepth = this.undoStack.length;
	}

	updateText(id: string, text: string): void {
		const existing = this.texts.get(id);
		if (!existing) return;
		const updated: TextBox = { ...existing, text };
		this.texts.set(id, updated);
		this.queueTextSend(updated);
	}

	moveText(id: string, x: number, y: number): void {
		const existing = this.texts.get(id);
		if (!existing) return;
		const updated: TextBox = { ...existing, x, y };
		this.texts.set(id, updated);
		this.queueTextSend(updated);
	}

	commitText(id: string): void {
		const box = this.texts.get(id);
		if (!box) return;
		if (this.editingTextId === id) this.editingTextId = null;
		// If the user committed without typing anything, drop the box
		// rather than persisting an empty placeholder.
		if (!box.text.trim()) {
			this.discardEmptyText(id);
			return;
		}
		this.flushTextSend(id);
	}

	private forgetText(id: string): void {
		this.texts.delete(id);
		this.textOwners.delete(id);
		this.textActivity.delete(id);
		this.cancelTextSend(id);
		if (this.editingTextId === id) this.editingTextId = null;
	}

	// Server applyTextDelete returns false for unknown ids, so a fire-and-forget
	// delete here is a safe no-op even if no broadcast ever published this box.
	private discardEmptyText(id: string): void {
		const box = this.texts.get(id);
		if (!box) return;
		this.send('text_delete', { id } satisfies TextDeletePayload);
		if (box.groupId && this.undoStack[this.undoStack.length - 1] === box.groupId) {
			this.undoStack.pop();
			this.undoDepth = this.undoStack.length;
		}
		this.forgetText(id);
	}

	private queueTextSend(box: TextBox): void {
		this.textPending.set(box.id, box);
		if (this.textSendTimers.has(box.id)) return;
		const t = setTimeout(() => {
			this.textSendTimers.delete(box.id);
			this.flushTextSend(box.id);
		}, TEXT_SEND_INTERVAL_MS);
		this.textSendTimers.set(box.id, t);
	}

	private flushTextSend(id: string): void {
		const pending = this.textPending.get(id);
		const t = this.textSendTimers.get(id);
		if (t !== undefined) {
			clearTimeout(t);
			this.textSendTimers.delete(id);
		}
		if (!pending) return;
		this.textPending.delete(id);
		this.send('text', pending);
	}

	private cancelTextSend(id: string): void {
		const t = this.textSendTimers.get(id);
		if (t !== undefined) {
			clearTimeout(t);
			this.textSendTimers.delete(id);
		}
		this.textPending.delete(id);
	}

	screenToWorld(sx: number, sy: number): { x: number; y: number } {
		const vp = this.viewport;
		return { x: (sx - vp.tx) / vp.scale, y: (sy - vp.ty) / vp.scale };
	}

	worldToScreen(wx: number, wy: number): { x: number; y: number } {
		const vp = this.viewport;
		return { x: wx * vp.scale + vp.tx, y: wy * vp.scale + vp.ty };
	}

	panBy(dx: number, dy: number): void {
		this.breakFollowOnUserInput();
		const vp = this.viewport;
		this.viewport = { tx: vp.tx + dx, ty: vp.ty + dy, scale: vp.scale };
		this.markViewportDirty();
	}

	// zoomAt scales around a fixed screen pivot. Keeping the world point
	// under the cursor stationary across a zoom is the only thing that
	// makes wheel-zoom feel natural — without it the camera drifts.
	zoomAt(sx: number, sy: number, factor: number): void {
		this.breakFollowOnUserInput();
		const vp = this.viewport;
		const next = clamp(vp.scale * factor, MIN_SCALE, MAX_SCALE);
		if (next === vp.scale) return;
		const wx = (sx - vp.tx) / vp.scale;
		const wy = (sy - vp.ty) / vp.scale;
		this.viewport = { tx: sx - wx * next, ty: sy - wy * next, scale: next };
		this.markViewportDirty();
	}

	resetView(): void {
		this.breakFollowOnUserInput();
		this.viewport = { tx: 0, ty: 0, scale: 1 };
		this.markViewportDirty();
	}

	follow(userId: string): void {
		this.followingId = userId;
		const last = this.peerViewports.get(userId);
		if (last) this.applyRemoteViewport(last);
	}

	unfollow(): void {
		this.followingId = null;
	}

	// reapplyFollow re-centers on the followed peer's last shared viewport.
	// Called on window resize so the follow stays visually stable when our
	// screen dimensions change underneath the tx/ty we previously derived.
	reapplyFollow(): void {
		if (!this.followingId) return;
		const last = this.peerViewports.get(this.followingId);
		if (last) this.applyRemoteViewport(last);
	}

	// applyRemoteViewport re-centers our own viewport on the remote's
	// world center at their zoom level. We compute tx/ty from our screen
	// size — sharing raw tx/ty would not survive a screen-size mismatch.
	private applyRemoteViewport(vp: ViewportShare): void {
		const w = window.innerWidth;
		const h = window.innerHeight;
		this.suppressBreakFollow = true;
		this.viewport = {
			scale: vp.scale,
			tx: w / 2 - vp.cx * vp.scale,
			ty: h / 2 - vp.cy * vp.scale
		};
		this.suppressBreakFollow = false;
		this.markViewportDirty();
	}

	private breakFollowOnUserInput(): void {
		if (this.suppressBreakFollow) return;
		this.followingId = null;
	}

	private markViewportDirty(): void {
		this.viewportShareDirty = true;
		if (this.viewportShareTimer !== undefined) return;
		this.viewportShareTimer = setTimeout(() => {
			this.viewportShareTimer = undefined;
			if (!this.viewportShareDirty) return;
			this.viewportShareDirty = false;
			const vp = this.viewport;
			const w = window.innerWidth;
			const h = window.innerHeight;
			const cx = (w / 2 - vp.tx) / vp.scale;
			const cy = (h / 2 - vp.ty) / vp.scale;
			this.send('viewport', { cx, cy, scale: vp.scale } satisfies ViewportShare);
		}, VIEWPORT_SHARE_INTERVAL_MS);
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
			case 'text': {
				const from = env.from ?? '';
				const box = env.data as TextBox;
				if (!box?.id) break;
				this.texts.set(box.id, box);
				// First sender wins ownership. Once recorded the owner is
				// stable so a stray "me" client-side flag cannot override.
				if (!this.textOwners.has(box.id)) {
					this.textOwners.set(box.id, from || 'me');
				}
				this.textActivity.set(box.id, performance.now());
				break;
			}
			case 'text_delete': {
				const id = (env.data as TextDeletePayload | undefined)?.id;
				if (id) this.forgetText(id);
				break;
			}
			case 'chat':
				this.handleRemoteChat(env.from ?? '', env.data as ChatPayload);
				break;
			case 'presence': {
				const users = ((env.data as { users?: PresenceUser[] })?.users ?? []) as PresenceUser[];
				this.members = users;
				// Drop follow + cached viewports for anyone who left so the
				// avatar UI never shows a stale follow target.
				if (this.followingId && !users.some((u) => u.id === this.followingId)) {
					this.followingId = null;
				}
				const ids = new Set(users.map((u) => u.id));
				let mutated = false;
				for (const id of this.peerViewports.keys()) {
					if (!ids.has(id)) {
						this.peerViewports.delete(id);
						mutated = true;
					}
				}
				if (mutated) this.peerViewports = new Map(this.peerViewports);
				break;
			}
			case 'snapshot': {
				// A fresh snapshot means our local history may be stale
				// (e.g. we just reconnected). Drop the undo/redo stacks since
				// their group IDs reference items we no longer own.
				this.resetUndoRedo();
				const snap = env.data as SnapshotPayload | undefined;
				this.onSnapshot?.((snap?.strokes ?? []) as Stroke[]);
				this.texts.clear();
				this.textOwners.clear();
				this.textActivity.clear();
				for (const t of snap?.texts ?? []) {
					this.texts.set(t.id, t);
					// Ownership for snapshot texts is unknown to us — the
					// server doesn't track who created which box. Treat them
					// as foreign-owned (read-only) until proven otherwise.
					this.textOwners.set(t.id, '?');
				}
				this.editingTextId = null;
				break;
			}
			case 'room_meta':
				this.roomMeta = env.data as RoomMetaPayload;
				break;
			case 'pong':
				this.handlePong(env.data as PongPayload);
				break;
			case 'viewport': {
				const from = env.from ?? '';
				if (!from) break;
				const vp = env.data as ViewportShare;
				const next = new Map(this.peerViewports);
				next.set(from, vp);
				this.peerViewports = next;
				if (this.followingId === from) {
					this.applyRemoteViewport(vp);
				}
				break;
			}
			case 'clear':
				this.resetUndoRedo();
				this.texts.clear();
				this.textOwners.clear();
				this.textActivity.clear();
				this.editingTextId = null;
				for (const id of Array.from(this.textSendTimers.keys())) this.cancelTextSend(id);
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

// widthToFontSize maps the existing pen-width slider onto a sensible
// font-size range so the text tool reuses the width control without a
// new UI knob. Floor of 12 keeps body text legible at low zoom.
function widthToFontSize(width: number): number {
	if (width <= 2) return 14;
	if (width <= 4) return 18;
	if (width <= 6) return 22;
	return 28;
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
