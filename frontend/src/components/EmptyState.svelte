<script lang="ts">
	import { client } from '../lib/client.svelte';

	let { hasStrokes }: { hasStrokes: boolean } = $props();
	let connected = $derived(client.connected);
</script>

{#if !hasStrokes && connected}
	<div class="hint" aria-hidden="true">
		<svg viewBox="0 0 64 64" width="56" height="56">
			<path
				d="M8 48 C 16 16, 30 56, 38 24 S 56 44, 60 18"
				fill="none"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				stroke-linejoin="round"
				opacity="0.55"
			/>
		</svg>
		<p class="title">Draw something</p>
		<p class="sub">Anyone in this room can see your strokes the moment you make them.</p>
	</div>
{/if}

<style>
	.hint {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		color: var(--fg-faint);
		pointer-events: none;
		text-align: center;
		padding: 0 24px;
		animation: rise 420ms var(--ease-out);
	}

	.title {
		margin: 8px 0 0;
		font-size: 18px;
		font-weight: 600;
		color: var(--fg-muted);
		letter-spacing: -0.01em;
	}

	.sub {
		margin: 0;
		max-width: 36ch;
		font-size: 13px;
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
