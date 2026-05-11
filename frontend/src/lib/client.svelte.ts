import type {
	ChatPayload,
	CursorPos,
	Envelope,
	LaserPos,
	MessageType,
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

export type Tool = 'pen' | 'eraser' | 'laser';

const RECONNECT_DELAY_MS = 1500;
const CURSOR_THROTTLE_MS = 33; // ~30Hz
const LASER_THROTTLE_MS = 33;
const LASER_TRAIL_TTL_MS = 1500;
const LASER_TRAIL_CAP = 32;
const CHAT_HISTORY_CAP = 200;

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

	// ==== internals ====
	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private cursorTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingCursor: CursorPos | null = null;
	private laserTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingLaser: LaserPos | null = null;
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
		};
		socket.onclose = () => {
			this.connected = false;
			this.connecting = false;
			this.scheduleReconnect();
		};
		socket.onerror = () => {
			socket.close();
		};
		socket.onmessage = (ev) => this.handleMessage(ev);
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
