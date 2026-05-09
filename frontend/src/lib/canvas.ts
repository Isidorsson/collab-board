import type { Stroke } from './protocol';

/**
 * CanvasController owns the 2D drawing context and a replay buffer so
 * the board survives window resizes (and eventually theme switches)
 * without losing pixels. Strokes are drawn imperatively as they arrive;
 * we keep the same list so we can rebuild the raster on demand.
 *
 * Eraser uses destination-out compositing — it removes pixels rather
 * than painting over them. The canvas itself is transparent so the
 * page background shows through where we erase.
 */
export class CanvasController {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private dpr = 1;
	private buffer: Stroke[] = [];

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		const ctx = canvas.getContext('2d', { alpha: true });
		if (!ctx) {
			throw new Error('2D canvas context unavailable');
		}
		this.ctx = ctx;
		this.resize();
	}

	resize(): void {
		this.dpr = window.devicePixelRatio || 1;
		const rect = this.canvas.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width));
		const h = Math.max(1, Math.round(rect.height));
		this.canvas.width = w * this.dpr;
		this.canvas.height = h * this.dpr;
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.redraw();
	}

	drawStroke(s: Stroke): void {
		this.buffer.push(s);
		this.paint(s);
	}

	replay(strokes: Stroke[]): void {
		this.buffer = strokes.slice();
		this.clearRaster();
		for (const s of this.buffer) {
			this.paint(s);
		}
	}

	clear(): void {
		this.buffer = [];
		this.clearRaster();
	}

	// removeGroup drops every buffered segment whose groupId matches and
	// repaints from scratch. We cannot "unpaint" pixels selectively
	// without a full redraw because erase strokes use destination-out
	// compositing — order and presence both matter for the final raster.
	removeGroup(groupId: string): boolean {
		if (!groupId) return false;
		const next = this.buffer.filter((s) => s.groupId !== groupId);
		if (next.length === this.buffer.length) return false;
		this.buffer = next;
		this.redraw();
		return true;
	}

	getGroup(groupId: string): Stroke[] {
		if (!groupId) return [];
		return this.buffer.filter((s) => s.groupId === groupId);
	}

	get strokeCount(): number {
		return this.buffer.length;
	}

	redraw(): void {
		this.clearRaster();
		for (const s of this.buffer) {
			this.paint(s);
		}
	}

	private clearRaster(): void {
		const rect = this.canvas.getBoundingClientRect();
		// Clear in CSS pixels — we are running with a DPR transform applied.
		this.ctx.save();
		this.ctx.setTransform(1, 0, 0, 1, 0, 0);
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.restore();
		// Restore the DPR transform we set up in resize().
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		void rect;
	}

	private paint(s: Stroke): void {
		const erase = s.mode === 'erase';
		this.ctx.save();
		this.ctx.lineCap = 'round';
		this.ctx.lineJoin = 'round';
		this.ctx.lineWidth = Math.max(0.5, s.width || 2);
		this.ctx.strokeStyle = s.color || '#000';
		this.ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
		this.ctx.beginPath();
		this.ctx.moveTo(s.x1, s.y1);
		this.ctx.lineTo(s.x2, s.y2);
		this.ctx.stroke();
		this.ctx.restore();
	}
}
