<script lang="ts">
	import { client } from '../lib/client.svelte';
	import type { PresenceUser } from '../lib/protocol';

	const VISIBLE_CAP = 4;

	let members = $derived(client.members);
	let visible = $derived(members.slice(0, VISIBLE_CAP));
	let overflow = $derived(Math.max(0, members.length - VISIBLE_CAP));

	function initials(u: PresenceUser): string {
		const parts = u.name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return '?';
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}
</script>

<div class="stack" aria-label="People in this room">
	{#each visible as u (u.id)}
		<span class="avatar" style:background={u.color} title={u.name}>
			<span class="initials">{initials(u)}</span>
			<span class="name">{u.name}</span>
		</span>
	{/each}
	{#if overflow > 0}
		<span class="avatar more" title="{overflow} more">+{overflow}</span>
	{/if}
	<span class="count" aria-live="polite">
		{members.length}
		<span class="count-label"
			>{members.length === 1 ? 'person' : 'people'}</span
		>
	</span>
</div>

<style>
	.stack {
		display: inline-flex;
		align-items: center;
		gap: 0;
		padding: 6px 12px 6px 6px;
		border-radius: var(--radius-pill);
		background: var(--surface-glass);
		border: 1px solid var(--border);
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		text-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
		border: 2px solid var(--bg);
		position: relative;
		margin-left: -6px;
		transition: transform 160ms var(--ease-out);
	}

	.avatar:first-child {
		margin-left: 0;
	}

	.avatar:hover {
		transform: translateY(-2px);
		z-index: 2;
	}

	.avatar:hover .name {
		opacity: 1;
		transform: translate(-50%, 0);
	}

	.initials {
		pointer-events: none;
	}

	.name {
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		transform: translate(-50%, 4px);
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		background: var(--surface-strong);
		color: var(--fg);
		font-size: 11px;
		font-weight: 500;
		text-shadow: none;
		border: 1px solid var(--border);
		white-space: nowrap;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 160ms var(--ease-out),
			transform 160ms var(--ease-out);
		box-shadow: var(--shadow-1);
	}

	.avatar.more {
		background: var(--surface-strong);
		color: var(--fg-muted);
		border: 2px solid var(--bg);
		font-weight: 600;
	}

	.count {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
		margin-left: 12px;
		padding-left: 10px;
		border-left: 1px solid var(--border);
		font-size: 12px;
		color: var(--fg);
		font-weight: 600;
	}

	.count-label {
		font-weight: 400;
		color: var(--fg-muted);
	}

	@media (max-width: 640px) {
		.count-label {
			display: none;
		}
	}
</style>
