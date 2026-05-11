<script lang="ts">
	import { client } from '../lib/client.svelte';

	let now = $state(performance.now());
	let frame: number | undefined;

	$effect(() => {
		const tick = () => {
			now = performance.now();
			client.pruneStaleCursors(now);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	});

	let cursors = $derived(client.cursors);
	let vp = $derived(client.viewport);
</script>

<div class="layer" aria-hidden="true">
	{#each Array.from(cursors.entries()) as [id, c] (id)}
		{@const idle = now - c.lastSeen}
		{@const opacity = idle < 1500 ? 1 : Math.max(0, 1 - (idle - 1500) / 3500)}
		{@const sx = c.x * vp.scale + vp.tx}
		{@const sy = c.y * vp.scale + vp.ty}
		<div class="cursor" style:left="{sx}px" style:top="{sy}px" style:opacity>
			<svg viewBox="0 0 14 14" width="18" height="18">
				<path
					d="M1 1 L1 12 L4 9 L7 13 L9 12 L6 8 L11 8 Z"
					fill={c.color}
					stroke="rgba(0,0,0,0.4)"
					stroke-width="0.5"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="tag" style:background={c.color}>{c.name}</span>
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

	.cursor {
		position: absolute;
		transform: translate(-2px, -2px);
		transition: opacity 200ms linear;
		will-change: transform, left, top;
	}

	.tag {
		position: absolute;
		left: 14px;
		top: 14px;
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		font-size: 11px;
		font-weight: 600;
		color: #fff;
		text-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
		white-space: nowrap;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
	}
</style>
