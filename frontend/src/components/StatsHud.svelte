<script lang="ts">
	import { client } from '../lib/client.svelte';

	let rtt = $derived(client.rttMs);
	let depth = $derived(client.queueDepth);
	let cap = $derived(client.queueCap);
	let evictions = $derived(client.evictions);
	let members = $derived(client.members.length);
	let visible = $derived(client.hudVisible);

	let fillPct = $derived(cap > 0 ? Math.min(100, (depth / cap) * 100) : 0);
	let rttClass = $derived(rtt === 0 ? '' : rtt < 80 ? 'good' : rtt < 200 ? 'warn' : 'bad');
	let fillClass = $derived(fillPct < 50 ? 'good' : fillPct < 85 ? 'warn' : 'bad');
</script>

{#if visible}
	<aside class="hud" aria-label="Live connection statistics">
		<header>
			<span>net</span>
			<button
				type="button"
				class="close"
				aria-label="Hide HUD"
				onclick={() => (client.hudVisible = false)}
			>×</button>
		</header>
		<dl>
			<dt>rtt</dt>
			<dd class={rttClass}>
				{rtt === 0 ? '—' : `${Math.round(rtt)} ms`}
			</dd>
			<dt>send buffer</dt>
			<dd class={fillClass}>
				{depth}/{cap || '—'}
				<span class="bar" aria-hidden="true">
					<span class="fill {fillClass}" style:width="{fillPct}%"></span>
				</span>
			</dd>
			<dt>evictions</dt>
			<dd class={evictions > 0 ? 'warn' : ''}>{evictions}</dd>
			<dt>members</dt>
			<dd>{members}</dd>
		</dl>
	</aside>
{/if}

<style>
	.hud {
		position: absolute;
		top: 64px;
		right: 18px;
		z-index: 6;
		pointer-events: auto;
		min-width: 180px;
		padding: 10px 12px;
		background: var(--surface-strong);
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 10px);
		box-shadow: var(--shadow-2);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		color: var(--fg);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--fg-muted);
	}

	.close {
		background: none;
		border: 0;
		color: var(--fg-muted);
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		padding: 0 2px;
	}

	.close:hover {
		color: var(--fg);
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 10px;
		margin: 0;
	}

	dt {
		color: var(--fg-muted);
	}

	dd {
		margin: 0;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	dd.good {
		color: #22c55e;
	}

	dd.warn {
		color: #f59e0b;
	}

	dd.bad {
		color: #ef4444;
	}

	.bar {
		display: block;
		margin-top: 2px;
		height: 3px;
		background: var(--border);
		border-radius: 2px;
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		transition: width 200ms ease-out;
		background: currentColor;
	}
</style>
