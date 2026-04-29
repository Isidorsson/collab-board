import type {
	ChatPayload,
	CursorPos,
	Envelope,
	MessageType,
	PresenceUser,
	RoomMetaPayload,
	SnapshotPayload,
	Stroke,
	StrokeMode
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

export type Tool = 'pen' | 'eraser';

const RECONNECT_DELAY_MS = 1500;
const CURSOR_THROTTLE_MS = 33; // ~30Hz
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

	myName = $state('');
	myColor = $state(PALETTE[5]);

	tool = $state<Tool>('pen');
	color = $state(PALETTE[5]);
	width = $state(3);

	// ==== internals ====
	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private cursorTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingCursor: CursorPos | null = null;
	private chatSeq = 0;
	private chosenRoom = '';

	// ==== callbacks (registered by the canvas component) ====
	onStroke: ((stroke: Stroke) => void) | null = null;
	onSnapshot: ((strokes: Stroke[]) => void) | null = null;
	onClear: (() => void) | null = null;

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

	clearBoard(): void {
		this.send('clear', {});
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
			mode
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
			case 'cursor':
				this.handleCursor(env.from ?? '', env.data as CursorPos);
				break;
			case 'chat':
				this.handleRemoteChat(env.from ?? '', env.data as ChatPayload);
				break;
			case 'presence':
				this.members = ((env.data as { users?: PresenceUser[] })?.users ?? []) as PresenceUser[];
				break;
			case 'snapshot':
				this.onSnapshot?.(((env.data as SnapshotPayload | undefined)?.strokes ?? []) as Stroke[]);
				break;
			case 'room_meta':
				this.roomMeta = env.data as RoomMetaPayload;
				break;
			case 'clear':
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

export const client = new CollabClient();
