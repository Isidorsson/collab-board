<script lang="ts">
	import { client } from '../lib/client.svelte';
	import { CanvasController } from '../lib/canvas';
	import RemoteCursors from './RemoteCursors.svelte';
	import LaserTrails from './LaserTrails.svelte';
	import EmptyState from './EmptyState.svelte';

	let canvasEl: HTMLCanvasElement | null = $state(null);
	let controller: CanvasController | null = $state(null);
	let drawing = $state(false);
	let lasering = $state(false);
	let last: { x: number; y: number } | null = $state(null);
	let strokeCount = $state(0);

	$effect(() => {
		if (!canvasEl) return;
		const c = new CanvasController(canvasEl);
		controller = c;

		const onResize = () => c.resize();
		window.addEventListener('resize', onResize);

		client.onStroke = (s) => {
			c.drawStroke(s);
			strokeCount = c.strokeCount;
		};
		client.onSnapshot = (strokes) => {
			c.replay(strokes);
			strokeCount = c.strokeCount;
		};
		client.onClear = () => {
			c.clear();
			strokeCount = 0;
		};
		client.onRemoveGroup = (id) => {
			const removed = c.removeGroup(id);
			strokeCount = c.strokeCount;
			return removed;
		};
		client.onGetGroup = (id) => c.getGroup(id);

		return () => {
			window.removeEventListener('resize', onResize);
			client.onStroke = null;
			client.onSnapshot = null;
			client.onClear = null;
			client.onRemoveGroup = null;
			client.onGetGroup = null;
			controller = null;
		};
	});

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

			// Undo/redo: Ctrl+Z (undo), Ctrl+Y or Ctrl+Shift+Z (redo).
			// Keep Cmd on macOS too via metaKey. Tested before single-key
			// shortcuts so plain "z" never collides.
			const mod = e.ctrlKey || e.metaKey;
			if (mod && (e.key === 'z' || e.key === 'Z')) {
				e.preventDefault();
				if (e.shiftKey) client.redo();
				else client.undo();
				return;
			}
			if (mod && (e.key === 'y' || e.key === 'Y')) {
				e.preventDefault();
				client.redo();
				return;
			}

			if (e.key === 'p' || e.key === 'P') {
				client.tool = 'pen';
			} else if (e.key === 'e' || e.key === 'E') {
				client.tool = 'eraser';
			} else if (e.key === 'l' || e.key === 'L') {
				client.tool = 'laser';
			} else if (/^[1-8]$/.test(e.key)) {
				const idx = parseInt(e.key, 10) - 1;
				const color = client.palette[idx];
				if (color) {
					client.color = color;
					client.myColor = color;
				}
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function localPos(e: PointerEvent): { x: number; y: number } {
		const el = canvasEl;
		if (!el) return { x: 0, y: 0 };
		const r = el.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function onPointerDown(e: PointerEvent) {
		if (!controller) return;
		// Only act on the primary pointer; ignore right-click / multi-touch.
		if (e.button !== undefined && e.button !== 0) return;
		const p = localPos(e);
		if (client.tool === 'laser') {
			// Laser is hold-to-ping: no stroke group, no canvas writes.
			lasering = true;
			client.queueLaser(p);
			canvasEl?.setPointerCapture?.(e.pointerId);
			return;
		}
		drawing = true;
		last = p;
		client.beginStrokeGroup();
		canvasEl?.setPointerCapture?.(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!controller) return;
		const p = localPos(e);
		client.queueCursor(p);
		if (lasering) {
			client.queueLaser(p);
			return;
		}
		if (!drawing || !last) return;

		const stroke = client.makeStroke(
			last.x,
			last.y,
			p.x,
			p.y,
			client.tool === 'eraser' ? 'erase' : 'draw'
		);
		controller.drawStroke(stroke);
		strokeCount = controller.strokeCount;
		client.sendStroke(stroke);
		last = p;
	}

	function onPointerUp(e: PointerEvent) {
		if (drawing) client.endStrokeGroup();
		drawing = false;
		lasering = false;
		last = null;
		canvasEl?.releasePointerCapture?.(e.pointerId);
	}
</script>

<div class="board" data-tool={client.tool}>
	<canvas
		bind:this={canvasEl}
		class="surface"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onpointerleave={onPointerUp}
	></canvas>
	<LaserTrails />
	<RemoteCursors />
	<EmptyState hasStrokes={strokeCount > 0} />
</div>

<style>
	.board {
		position: relative;
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		background: var(--paper);
	}

	.surface {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: crosshair;
		user-select: none;
		-webkit-user-select: none;
	}

	.board[data-tool='eraser'] .surface {
		cursor:
			url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><circle cx='10' cy='10' r='8' fill='none' stroke='%23999' stroke-width='1.5' stroke-dasharray='2 2'/></svg>")
				10 10,
			crosshair;
	}

	.board[data-tool='laser'] .surface {
		cursor:
			url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><circle cx='8' cy='8' r='4' fill='%23ef4444'/><circle cx='8' cy='8' r='6' fill='none' stroke='%23ef4444' stroke-opacity='0.4' stroke-width='1.5'/></svg>")
				8 8,
			crosshair;
	}
</style>
