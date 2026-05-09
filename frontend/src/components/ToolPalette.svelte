<script lang="ts">
	import { client, type Tool } from '../lib/client.svelte';

	const widths = [
		{ value: 2, label: 'thin' },
		{ value: 4, label: 'medium' },
		{ value: 8, label: 'thick' }
	];

	let tool = $derived(client.tool);
	let color = $derived(client.color);
	let width = $derived(client.width);
	let canUndo = $derived(client.undoDepth > 0);
	let canRedo = $derived(client.redoDepth > 0);

	function pickTool(next: Tool) {
		client.tool = next;
	}

	function pickColor(c: string) {
		client.color = c;
		client.myColor = c;
	}

	function pickWidth(w: number) {
		client.width = w;
	}

	function clearBoard() {
		const ok = window.confirm(
			'Clear the board for everyone in this room?\nThis cannot be undone.'
		);
		if (ok) client.clearBoard();
	}
</script>

<div class="palette" role="toolbar" aria-label="Drawing tools">
	<div class="group" role="radiogroup" aria-label="Tool">
		<button
			type="button"
			class="icon-btn"
			role="radio"
			aria-checked={tool === 'pen'}
			aria-label="Pen"
			title="Pen (P)"
			onclick={() => pickTool('pen')}
		>
			<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
				<path
					d="M3 17l3.5-1 9-9-2.5-2.5-9 9z"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
				<path
					d="M13 4.5l2.5 2.5"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
			</svg>
		</button>
		<button
			type="button"
			class="icon-btn"
			role="radio"
			aria-checked={tool === 'eraser'}
			aria-label="Eraser"
			title="Eraser (E)"
			onclick={() => pickTool('eraser')}
		>
			<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
				<path
					d="M4 14l6 6 6-6-8-8-6 6 2 2z"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
				<path d="M9 9l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
			</svg>
		</button>
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group swatches" role="radiogroup" aria-label="Color">
		{#each client.palette as c (c)}
			<button
				type="button"
				class="swatch"
				role="radio"
				aria-checked={color === c}
				aria-label="Color {c}"
				style:--swatch={c}
				class:selected={color === c}
				onclick={() => pickColor(c)}
			></button>
		{/each}
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group" role="radiogroup" aria-label="Stroke width">
		{#each widths as w (w.value)}
			<button
				type="button"
				class="icon-btn width"
				role="radio"
				aria-checked={width === w.value}
				aria-label="{w.label} stroke"
				title="{w.label} stroke"
				onclick={() => pickWidth(w.value)}
			>
				<span class="width-dot" style:width="{w.value * 2}px" style:height="{w.value * 2}px"></span>
			</button>
		{/each}
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group" aria-label="History">
		<button
			type="button"
			class="icon-btn"
			aria-label="Undo"
			title="Undo (Ctrl+Z)"
			disabled={!canUndo}
			onclick={() => client.undo()}
		>
			<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
				<path
					d="M7 7L3 11l4 4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
				<path
					d="M3 11h9a4 4 0 0 1 0 8h-2"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
		<button
			type="button"
			class="icon-btn"
			aria-label="Redo"
			title="Redo (Ctrl+Y)"
			disabled={!canRedo}
			onclick={() => client.redo()}
		>
			<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
				<path
					d="M13 7l4 4-4 4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
				<path
					d="M17 11H8a4 4 0 0 0 0 8h2"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	</div>

	<span class="divider" aria-hidden="true"></span>

	<button
		type="button"
		class="icon-btn destructive"
		aria-label="Clear board for everyone"
		title="Clear board"
		onclick={clearBoard}
	>
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<path
				d="M5 6h10M8 6V4h4v2M7 6l1 10h4l1-10"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</button>
</div>

<style>
	.palette {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px;
		background: var(--surface-strong);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		box-shadow: var(--shadow-2);
		-webkit-backdrop-filter: blur(14px);
		backdrop-filter: blur(14px);
	}

	.group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.divider {
		width: 1px;
		height: 22px;
		background: var(--border-strong);
		margin: 0 2px;
	}

	.swatches {
		gap: 4px;
		padding: 0 4px;
	}

	.swatch {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--swatch);
		border: 2px solid transparent;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
		transition:
			transform 140ms var(--ease-out),
			border-color 140ms var(--ease-out);
		cursor: pointer;
	}

	.swatch:hover {
		transform: scale(1.12);
	}

	.swatch.selected {
		border-color: var(--fg);
		transform: scale(1.12);
	}

	.swatch:focus-visible {
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.15),
			0 0 0 2px var(--accent);
	}

	.icon-btn.width {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.width-dot {
		display: inline-block;
		border-radius: 50%;
		background: currentColor;
	}

	.destructive {
		color: var(--fg-muted);
	}

	.destructive:hover {
		background: rgba(239, 68, 68, 0.12);
		color: var(--err);
	}

	@media (max-width: 540px) {
		.palette {
			gap: 2px;
			padding: 4px;
		}
		.swatches {
			gap: 2px;
		}
		.swatch {
			width: 18px;
			height: 18px;
		}
	}
</style>
