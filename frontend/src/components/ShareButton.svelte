<script lang="ts">
	import { client } from '../lib/client.svelte';

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	let roomCode = $derived(client.roomCode);
	let shareUrl = $derived.by(() => {
		if (typeof window === 'undefined') return '';
		const url = new URL(window.location.href);
		url.searchParams.set('room', roomCode);
		return url.toString();
	});

	async function copyShare() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1600);
		} catch {
			// graceful fallback: select-and-prompt
			window.prompt('Copy this room link', shareUrl);
		}
	}
</script>

<button
	type="button"
	class="share"
	onclick={copyShare}
	aria-label="Copy room link"
	title="Copy invite link"
>
	<span class="label">room</span>
	<span class="code mono">{roomCode || '—'}</span>
	<span class="action" aria-hidden="true">
		{#if copied}
			<svg viewBox="0 0 20 20" width="14" height="14">
				<path
					d="M5 10.5l3 3 7-7"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="action-text">copied</span>
		{:else}
			<svg viewBox="0 0 20 20" width="14" height="14">
				<rect
					x="6"
					y="6"
					width="10"
					height="10"
					rx="2"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
				/>
				<rect
					x="3.5"
					y="3.5"
					width="10"
					height="10"
					rx="2"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					opacity="0.55"
				/>
			</svg>
			<span class="action-text">copy</span>
		{/if}
	</span>
</button>

<style>
	.share {
		display: inline-flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px 8px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-1);
		color: var(--fg);
		transition:
			background 160ms var(--ease-out),
			border-color 160ms var(--ease-out),
			transform 160ms var(--ease-out);
	}

	.share:hover {
		border-color: var(--border-strong);
		background: var(--surface-strong);
	}

	.share:active {
		transform: scale(0.98);
	}

	.label {
		text-transform: uppercase;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.12em;
		color: var(--fg-faint);
	}

	.code {
		font-size: 14px;
		font-weight: 600;
		color: var(--fg);
		text-transform: uppercase;
	}

	.action {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding-left: 12px;
		border-left: 1px solid var(--border);
		color: var(--fg-muted);
		transition: color 160ms var(--ease-out);
	}

	.share:hover .action {
		color: var(--accent);
	}

	.action-text {
		font-size: 12px;
		font-weight: 500;
	}
</style>
