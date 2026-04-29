<script lang="ts">
	import { client } from '../lib/client.svelte';

	let open = $state(false);
	let lastSeenId = $state(0);
	let textInput = $state('');
	let listEl: HTMLDivElement | null = $state(null);

	let chat = $derived(client.chat);
	let unread = $derived(open ? 0 : Math.max(0, chat.length - lastSeenIdSafe(chat, lastSeenId)));

	function lastSeenIdSafe(list: typeof chat, mark: number): number {
		// number of entries up to and including the marked id
		let count = 0;
		for (const e of list) {
			if (e.id <= mark) count++;
		}
		return count;
	}

	$effect(() => {
		// auto-scroll on new messages while open
		if (!open || !listEl) return;
		const el = listEl;
		queueMicrotask(() => {
			el.scrollTop = el.scrollHeight;
		});
	});

	$effect(() => {
		// when drawer is open, mark all current messages as seen
		if (open && chat.length > 0) {
			lastSeenId = chat[chat.length - 1].id;
		}
	});

	function toggle() {
		open = !open;
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const text = textInput.trim();
		if (!text) return;
		client.sendChat(text);
		textInput = '';
	}

	function timeOf(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="wrap" data-open={open}>
	<button
		type="button"
		class="toggle"
		aria-expanded={open}
		aria-controls="chat-panel"
		onclick={toggle}
	>
		<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
			<path
				d="M3 5h14v9H8l-4 3V5z"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linejoin="round"
			/>
		</svg>
		<span>chat</span>
		{#if unread > 0}
			<span class="badge" aria-label="{unread} unread messages">{unread}</span>
		{/if}
	</button>

	{#if open}
		<aside id="chat-panel" class="panel" aria-label="Room chat">
			<header class="head">
				<span class="title">Chat</span>
				<button type="button" class="icon-btn close" aria-label="Close chat" onclick={toggle}>
					<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<path
							d="M5 5l10 10M15 5L5 15"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</header>

			<div bind:this={listEl} class="list" role="log" aria-live="polite">
				{#if chat.length === 0}
					<p class="empty">No messages yet — say hi.</p>
				{/if}
				{#each chat as m (m.id)}
					<div class="msg">
						<div class="meta">
							<b style:color={m.color}>{m.name}</b>
							<time>{timeOf(m.at)}</time>
						</div>
						<div class="text">{m.text}</div>
					</div>
				{/each}
			</div>

			<form class="input" onsubmit={submit}>
				<input
					type="text"
					maxlength="500"
					placeholder="Message the room…"
					bind:value={textInput}
					aria-label="Chat message"
					autocomplete="off"
				/>
				<button
					type="submit"
					class="send"
					aria-label="Send"
					disabled={textInput.trim().length === 0}
				>
					<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<path
							d="M3 10l14-7-5 17-3-7-6-3z"
							fill="currentColor"
							stroke="currentColor"
							stroke-width="1"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
			</form>
		</aside>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
		display: inline-block;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: var(--radius-pill);
		background: var(--surface-glass);
		border: 1px solid var(--border);
		color: var(--fg-muted);
		font-size: 13px;
		font-weight: 500;
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		transition:
			background 160ms var(--ease-out),
			color 160ms var(--ease-out);
	}

	.toggle:hover {
		color: var(--fg);
		background: var(--surface);
	}

	.wrap[data-open='true'] .toggle {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: rgba(245, 165, 36, 0.3);
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 11px;
		font-weight: 700;
	}

	.panel {
		position: absolute;
		bottom: calc(100% + 10px);
		right: 0;
		width: min(360px, calc(100vw - 32px));
		max-height: min(60vh, 480px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: pop 180ms var(--ease-out);
	}

	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(4px) scale(0.99);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}

	.title {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--fg-muted);
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		scrollbar-width: thin;
	}

	.empty {
		margin: auto;
		color: var(--fg-faint);
		font-size: 13px;
	}

	.msg {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.meta {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.meta b {
		font-size: 12px;
		font-weight: 600;
	}

	.meta time {
		font-size: 10px;
		color: var(--fg-faint);
	}

	.text {
		font-size: 13px;
		color: var(--fg);
		word-break: break-word;
	}

	.input {
		display: flex;
		gap: 6px;
		padding: 10px 10px 10px 12px;
		border-top: 1px solid var(--border);
	}

	.input input {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 13px;
	}

	.input input::placeholder {
		color: var(--fg-faint);
	}

	.send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--accent-fg);
		transition: opacity 160ms var(--ease-out);
	}

	.send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.send:not(:disabled):hover {
		background: var(--accent-strong);
	}
</style>
