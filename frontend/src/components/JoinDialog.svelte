<script lang="ts">
	import { client } from '../lib/client.svelte';

	const ROOM_PATTERN = /^[A-Z0-9]{2,12}$/;

	function readInitialRoom(): string {
		if (typeof window === 'undefined') return '';
		const r = new URLSearchParams(window.location.search).get('room');
		return (r ?? '').toUpperCase();
	}

	let room = $state(readInitialRoom());
	let name = $state('');
	let color = $state(client.pickRandomColor());
	let touched = $state(false);

	let isValidRoom = $derived(ROOM_PATTERN.test(room));
	let isValidName = $derived(name.trim().length > 0);
	let canSubmit = $derived(isValidRoom && isValidName);

	function generateRoom(): string {
		const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // dropped easily-confused chars
		let out = '';
		const buf = new Uint32Array(4);
		crypto.getRandomValues(buf);
		for (const v of buf) out += alphabet[v % alphabet.length];
		return out;
	}

	function newRoom() {
		room = generateRoom();
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		touched = true;
		if (!canSubmit) return;
		client.connect(room, name.trim(), color);
	}

	$effect(() => {
		// Mirror the URL so refreshing keeps the room handle.
		if (typeof window === 'undefined' || !room) return;
		const url = new URL(window.location.href);
		url.searchParams.set('room', room);
		window.history.replaceState(null, '', url);
	});
</script>

<section class="screen" aria-labelledby="join-title">
	<div class="card panel">
		<header class="head">
			<div class="brand">
				<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
					<path
						d="M5 22 C 9 8, 13 28, 17 12 S 24 22, 27 10"
						fill="none"
						stroke="var(--accent)"
						stroke-width="3"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="wordmark">collab-board</span>
			</div>
			<h1 id="join-title" class="title">A room of your own.</h1>
			<p class="sub">
				Enter a room code to join, or roll a new one. Anyone with the same code can draw on the
				same board with you, in real time.
			</p>
		</header>

		<form class="form" onsubmit={submit} novalidate>
			<label class="field">
				<span class="field-label">Room</span>
				<div class="row">
					<input
						class="input mono code"
						type="text"
						maxlength="12"
						spellcheck="false"
						autocapitalize="characters"
						autocomplete="off"
						placeholder="ABCD"
						value={room}
						oninput={(e) => (room = (e.currentTarget.value || '').toUpperCase())}
						aria-invalid={touched && !isValidRoom}
					/>
					<button
						type="button"
						class="btn ghost"
						onclick={newRoom}
						aria-label="Generate a new room code"
					>
						<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
							<path
								d="M4 10a6 6 0 0 1 10.5-4M16 10a6 6 0 0 1-10.5 4"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
							/>
							<path
								d="M14 3v3.5h-3.5M6 17v-3.5h3.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
							/>
						</svg>
						<span>New</span>
					</button>
				</div>
				{#if touched && !isValidRoom}
					<span class="hint err">Room codes are 2–12 letters or digits.</span>
				{:else}
					<span class="hint">Share the code to invite someone — no accounts.</span>
				{/if}
			</label>

			<label class="field">
				<span class="field-label">Your name</span>
				<input
					class="input"
					type="text"
					maxlength="32"
					placeholder="What should others call you?"
					bind:value={name}
					autocomplete="off"
					aria-invalid={touched && !isValidName}
				/>
			</label>

			<fieldset class="field">
				<legend class="field-label">Your color</legend>
				<div class="swatches" role="radiogroup" aria-label="Choose your cursor color">
					{#each client.palette as c (c)}
						<button
							type="button"
							class="swatch"
							role="radio"
							aria-checked={color === c}
							aria-label="Color {c}"
							style:--swatch={c}
							class:selected={color === c}
							onclick={() => (color = c)}
						></button>
					{/each}
				</div>
			</fieldset>

			<button type="submit" class="btn primary" disabled={touched && !canSubmit}>
				Enter the room
				<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
					<path
						d="M4 10h11M11 5l5 5-5 5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</form>

		<footer class="foot">
			<span class="dot" aria-hidden="true"></span>
			<span>Boards are ephemeral — closing the last tab clears the room.</span>
		</footer>
	</div>
</section>

<style>
	.screen {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		min-height: 0;
	}

	.card {
		width: min(440px, 100%);
		padding: 28px;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--fg);
	}

	.wordmark {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--fg-muted);
	}

	.title {
		margin: 18px 0 6px;
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.15;
	}

	.sub {
		margin: 0;
		font-size: 13.5px;
		color: var(--fg-muted);
		line-height: 1.5;
	}

	.form {
		display: grid;
		gap: 18px;
		margin-top: 24px;
	}

	.field {
		display: grid;
		gap: 8px;
		border: 0;
		padding: 0;
		margin: 0;
	}

	.field-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--fg-muted);
	}

	.row {
		display: flex;
		gap: 8px;
	}

	.input {
		flex: 1;
		min-width: 0;
		padding: 12px 14px;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 15px;
		transition: border-color 160ms var(--ease-out);
	}

	.input::placeholder {
		color: var(--fg-faint);
	}

	.input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.input.code {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.input[aria-invalid='true'] {
		border-color: var(--err);
	}

	.hint {
		font-size: 12px;
		color: var(--fg-faint);
	}

	.hint.err {
		color: var(--err);
	}

	.swatches {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.swatch {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--swatch);
		border: 2px solid transparent;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
		transition:
			transform 140ms var(--ease-out),
			border-color 140ms var(--ease-out);
		cursor: pointer;
	}

	.swatch:hover {
		transform: scale(1.1);
	}

	.swatch.selected {
		border-color: var(--fg);
		transform: scale(1.1);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px 18px;
		border-radius: var(--radius-md);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 160ms var(--ease-out),
			border-color 160ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.btn.primary {
		background: var(--accent);
		color: var(--accent-fg);
		padding: 14px 20px;
	}

	.btn.primary:hover {
		background: var(--accent-strong);
	}

	.btn.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn.ghost {
		background: var(--surface);
		color: var(--fg-muted);
		border: 1px solid var(--border);
	}

	.btn.ghost:hover {
		color: var(--fg);
		border-color: var(--border-strong);
	}

	.foot {
		margin-top: 22px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--fg-faint);
	}

	.foot .dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
