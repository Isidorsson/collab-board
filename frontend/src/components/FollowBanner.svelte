<script lang="ts">
	import { client } from '../lib/client.svelte';

	let target = $derived(
		client.followingId ? client.members.find((u) => u.id === client.followingId) ?? null : null
	);
</script>

{#if target}
	<button
		type="button"
		class="banner"
		title="Stop following"
		onclick={() => client.unfollow()}
	>
		<span class="dot" style:background={target.color}></span>
		<span class="label">following <strong>{target.name}</strong></span>
		<span class="close" aria-hidden="true">×</span>
	</button>
{/if}

<style>
	.banner {
		position: absolute;
		top: 64px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 6;
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px 6px 8px;
		border-radius: var(--radius-pill);
		background: var(--surface-strong);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-2);
		font: 12px/1 inherit;
		color: var(--fg);
		cursor: pointer;
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
	}

	.banner:hover {
		border-color: var(--fg-muted);
	}

	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		box-shadow: 0 0 8px currentColor;
	}

	.label strong {
		font-weight: 700;
	}

	.close {
		color: var(--fg-muted);
		font-size: 14px;
		line-height: 1;
		padding-left: 4px;
		border-left: 1px solid var(--border);
	}
</style>
