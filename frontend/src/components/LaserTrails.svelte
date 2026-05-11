<script lang="ts">
	import { client } from '../lib/client.svelte';

	const TRAIL_TTL_MS = 1500;

	let now = $state(performance.now());
	let frame: number | undefined;

	$effect(() => {
		const tick = () => {
			now = performance.now();
			client.pruneLaserTrails(now);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	});

	let trails = $derived(client.laserTrails);
</script>

<div class="layer" aria-hidden="true">
	{#each Array.from(trails.entries()) as [id, points] (id)}
		{#each points as p, i (i)}
			{@const age = now - p.at}
			{@const t = Math.max(0, 1 - age / TRAIL_TTL_MS)}
			{@const s = client.worldToScreen(p.x, p.y)}
			<div
				class="dot"
				style:left="{s.x}px"
				style:top="{s.y}px"
				style:opacity={t * 0.9}
				style:background={p.color}
				style:--scale={0.4 + t * 0.6}
			></div>
		{/each}
	{/each}
</div>

<style>
	.layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.dot {
		position: absolute;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		transform: translate(-50%, -50%) scale(var(--scale, 1));
		filter: drop-shadow(0 0 6px currentColor);
		will-change: opacity, transform;
	}
</style>
