<script lang="ts">
	import { client } from '../lib/client.svelte';

	let connected = $derived(client.connected);
	let connecting = $derived(client.connecting);

	let label = $derived(connected ? 'live' : connecting ? 'connecting' : 'offline');
	let mood = $derived(connected ? 'ok' : connecting ? 'warn' : 'err');
</script>

<div
	class="status"
	role="status"
	aria-live="polite"
	data-mood={mood}
	data-prominent={!connected}
>
	<span class="dot" aria-hidden="true"></span>
	<span class="text">{label}</span>
</div>

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px 6px 10px;
		border-radius: var(--radius-pill);
		background: var(--surface-glass);
		border: 1px solid var(--border);
		font-size: 12px;
		color: var(--fg-muted);
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		transition:
			background 200ms var(--ease-out),
			color 200ms var(--ease-out),
			border-color 200ms var(--ease-out);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--fg-faint);
		box-shadow: 0 0 0 0 currentColor;
	}

	.status[data-mood='ok'] .dot {
		background: var(--ok);
		box-shadow: 0 0 12px rgba(22, 163, 74, 0.4);
	}

	.status[data-mood='warn'] .dot {
		background: var(--warn);
		animation: pulse 1.6s var(--ease-in-out) infinite;
	}

	.status[data-mood='err'] .dot {
		background: var(--err);
		animation: pulse 1.6s var(--ease-in-out) infinite;
	}

	.status[data-prominent='true'] {
		border-color: var(--border-strong);
		color: var(--fg);
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.45;
			transform: scale(1.25);
		}
	}
</style>
