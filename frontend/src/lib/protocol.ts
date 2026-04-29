// Wire protocol mirroring internal/ws/message.go on the server.
// Keep these types in sync; both sides serialize the same JSON shape.

export type MessageType =
	| 'join'
	| 'stroke'
	| 'cursor'
	| 'chat'
	| 'clear'
	| 'presence'
	| 'snapshot'
	| 'room_meta'
	| 'error';

export type StrokeMode = 'draw' | 'erase';

export interface Envelope<T = unknown> {
	type: MessageType;
	from?: string;
	data?: T;
}

export interface Stroke {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	color: string;
	width: number;
	mode?: StrokeMode;
}

export interface CursorPos {
	x: number;
	y: number;
}

export interface ChatPayload {
	text: string;
}

export interface PresenceUser {
	id: string;
	name: string;
	color: string;
}

export interface PresencePayload {
	users: PresenceUser[];
}

export interface SnapshotPayload {
	strokes: Stroke[];
}

export interface RoomMetaPayload {
	code: string;
	createdAt: number; // unix milliseconds
	capacity: number;
}

export interface ErrorPayload {
	message: string;
}
