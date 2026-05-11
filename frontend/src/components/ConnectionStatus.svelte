<script lang="ts">
	import { client } from '../lib/client.svelte';

	let connected = $derived(client.connected);
	let connecting = $derived(client.connecting);
	let rtt = $derived(client.rttMs);
	let hudOn = $derived(client.hudVisible);

	let label = $derived(connected ? 'live' : connecting ? 'connecting' : 'offline');
	let mood = $derived(connected ? 'ok' : connecting ? 'warn' : 'err');
	let rttLabel = $derived(connected && rtt > 0 ? `${Math.round(rtt)}ms` : '');

	function toggle() {
		if (!client.roomCode) return;
		client.hudVisible = !client.hudVisible;
	}
</script>

<button
	type="button"
	class="status"
	aria-live="polite"
	aria-pressed={hudOn}
	aria-label="Connection: {label}{rttLabel ? `, round trip ${rttLabel}` : ''}. Click to toggle network HUD."
	title="Toggle network HUD (`)"
	data-mood={mood}
	data-prominent={!connected}
	onclick={toggle}
>
	<span class="dot" aria-hidden="true"></span>
	<span class="text">{label}</span>
	{#if rttLabel}
		<span class="rtt">{rttLabel}</span>
	{/if}
</button>

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
		font-family: inherit;
		cursor: pointer;
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		transition:
			background 200ms var(--ease-out),
			color 200ms var(--ease-out),
			border-color 200ms var(--ease-out);
	}

	.status:hover {
		color: var(--fg);
		border-color: var(--border-strong);
	}

	.status[aria-pressed='true'] {
		color: var(--fg);
		border-color: var(--border-strong);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--fg-faint);
		box-shadow: 0 0 0 0 currentColor;
	}

	.rtt {
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		opacity: 0.75;
		padding-left: 4px;
		border-left: 1px solid var(--border);
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
