<script lang="ts">
	import { client } from '../lib/client.svelte';

	const SPURIOUS_BLUR_WINDOW_MS = 250;
	const DRAG_THRESHOLD_PX = 4;
	const DRAG_MIN_SCREEN_DELTA_PX = 0.5;

	let now = $state(performance.now());
	let frame: number | undefined;

	let vp = $derived(client.viewport);
	let editingId = $derived(client.editingTextId);
	const texts = client.texts;
	let boxes = $derived(Array.from(texts.values()));

	// Only run a RAF loop while a remote typing badge could be visible;
	// otherwise the typing-fade has no observable consumer.
	$effect(() => {
		if (!client.hasRecentTextActivity(performance.now())) return;
		const loop = () => {
			const t = performance.now();
			now = t;
			client.pruneTextActivity(t);
			if (!client.hasRecentTextActivity(t)) {
				frame = undefined;
				return;
			}
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = undefined;
		};
	});

	// WeakMap so the entry dies with the textarea node — avoids retaining
	// a removed DOM element per text box created.
	const mountTimes = new WeakMap<HTMLTextAreaElement, number>();

	function setupTextarea(node: HTMLTextAreaElement, initial: string) {
		node.value = initial;
		mountTimes.set(node, performance.now());
		queueMicrotask(() => {
			node.focus();
			const len = node.value.length;
			node.setSelectionRange(len, len);
		});
	}

	function onInput(id: string, e: Event) {
		const t = e.target as HTMLTextAreaElement;
		client.updateText(id, t.value);
	}

	function onKey(id: string, e: KeyboardEvent) {
		if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
			e.preventDefault();
			client.commitText(id);
		}
	}

	// The click that spawns the textarea fires a blur on the same tick:
	// reject blurs inside the mount window and re-focus, so the first
	// keystroke lands in the textarea instead of being lost.
	function onBlur(id: string, e: FocusEvent) {
		const node = e.target as HTMLTextAreaElement;
		const mountedAt = mountTimes.get(node);
		const age = mountedAt !== undefined ? performance.now() - mountedAt : Infinity;
		if (age < SPURIOUS_BLUR_WINDOW_MS) {
			queueMicrotask(() => node.focus());
			return;
		}
		client.commitText(id);
	}

	let drag: {
		id: string;
		startSx: number;
		startSy: number;
		originX: number;
		originY: number;
		moved: boolean;
	} | null = null;

	function onPointerDownExisting(id: string, e: PointerEvent) {
		if (client.tool !== 'text') return;
		if (!client.isTextOwnedByMe(id)) return;
		const box = client.texts.get(id);
		if (!box) return;
		drag = {
			id,
			startSx: e.clientX,
			startSy: e.clientY,
			originX: box.x,
			originY: box.y,
			moved: false
		};
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		e.stopPropagation();
	}

	function onPointerMoveExisting(e: PointerEvent) {
		if (!drag) return;
		const dxScreen = e.clientX - drag.startSx;
		const dyScreen = e.clientY - drag.startSy;
		if (!drag.moved) {
			if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
			drag.moved = true;
		}
		const scale = client.viewport.scale || 1;
		const nextX = drag.originX + dxScreen / scale;
		const nextY = drag.originY + dyScreen / scale;
		const box = client.texts.get(drag.id);
		// Skip sub-pixel-equivalent moves so high-Hz pointers don't
		// rebuild the SvelteMap on every micro-jitter.
		if (box) {
			const dPx = Math.hypot((nextX - box.x) * scale, (nextY - box.y) * scale);
			if (dPx < DRAG_MIN_SCREEN_DELTA_PX) return;
		}
		client.moveText(drag.id, nextX, nextY);
	}

	function onPointerUpExisting(id: string, e: PointerEvent) {
		const wasDrag = drag?.moved ?? false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		drag = null;
		if (wasDrag) return;
		client.editingTextId = id;
	}
</script>

<div class="layer">
	{#each boxes as box (box.id)}
		{@const s = client.worldToScreen(box.x, box.y)}
		{@const fontPx = box.size * vp.scale}
		{@const editing = editingId === box.id}
		{@const owned = client.isTextOwnedByMe(box.id)}
		{@const typist = client.textTypistName(box.id)}
		{@const recent = client.isTextRecentlyActive(box.id, now)}

		<div
			class="text-box"
			class:editing
			class:owned
			class:foreign={!owned}
			class:passthrough={!editing}
			style:left="{s.x}px"
			style:top="{s.y}px"
			style:color={box.color}
			style:font-size="{fontPx}px"
		>
			{#if editing}
				<textarea
					use:setupTextarea={box.text}
					data-text-id={box.id}
					class="input"
					rows="1"
					oninput={(e) => onInput(box.id, e)}
					onkeydown={(e) => onKey(box.id, e)}
					onblur={(e) => onBlur(box.id, e)}
				></textarea>
			{:else}
				<button
					type="button"
					class="display"
					tabindex={owned && client.tool === 'text' ? 0 : -1}
					aria-label={box.text || 'empty text'}
					onpointerdown={(e) => onPointerDownExisting(box.id, e)}
					onpointermove={onPointerMoveExisting}
					onpointerup={(e) => onPointerUpExisting(box.id, e)}
					onpointercancel={(e) => onPointerUpExisting(box.id, e)}
				>{box.text || ' '}</button>
			{/if}
			{#if !owned && typist && recent}
				<span class="typist" style:background={box.color}>{typist} typing…</span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.text-box {
		position: absolute;
		transform-origin: top left;
		white-space: pre;
		font-family: var(--font-sans, system-ui, sans-serif);
		font-weight: 500;
		line-height: 1.2;
	}

	:global([data-tool='text']) .text-box.owned.passthrough {
		pointer-events: auto;
	}

	.text-box.editing {
		pointer-events: auto;
	}

	.input {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 1px dashed currentColor;
		outline: none;
		padding: 2px 4px;
		margin: -3px -5px;
		resize: none;
		overflow: hidden;
		min-width: 40px;
		field-sizing: content;
	}

	.display {
		background: none;
		border: 0;
		padding: 0;
		margin: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: text;
		touch-action: none;
	}

	:global([data-tool='text']) .text-box.owned .display {
		cursor: move;
	}

	:global([data-tool='text']) .text-box.foreign .display {
		cursor: not-allowed;
	}

	.typist {
		position: absolute;
		left: 0;
		top: 100%;
		margin-top: 4px;
		padding: 2px 6px;
		font: 10px/1 ui-sans-serif, system-ui, sans-serif;
		color: #fff;
		border-radius: var(--radius-sm, 6px);
		text-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
		white-space: nowrap;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
	}
</style>
