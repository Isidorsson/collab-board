<script lang="ts">
	import { client } from './lib/client.svelte';
	import JoinDialog from './components/JoinDialog.svelte';
	import Whiteboard from './components/Whiteboard.svelte';
	import ToolPalette from './components/ToolPalette.svelte';
	import PresenceStack from './components/PresenceStack.svelte';
	import ChatDrawer from './components/ChatDrawer.svelte';
	import ShareButton from './components/ShareButton.svelte';
	import ConnectionStatus from './components/ConnectionStatus.svelte';
	import ThemeToggle from './components/ThemeToggle.svelte';
	import StatsHud from './components/StatsHud.svelte';

	$effect(() => {
		return () => client.disconnect();
	});

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
			// Backtick toggles the live network HUD. Visible only when joined.
			if (e.key === '`' && client.roomCode) {
				e.preventDefault();
				client.hudVisible = !client.hudVisible;
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	let joined = $derived(client.roomCode !== '');
</script>

{#if !joined}
	<JoinDialog />
{:else}
	<div class="app">
		<header class="topbar">
			<div class="topbar-row">
				<ShareButton />
				<div class="spacer"></div>
				<PresenceStack />
				<ThemeToggle />
			</div>
		</header>

		<main class="canvas">
			<Whiteboard />
			<StatsHud />
		</main>

		<footer class="bottombar">
			<div class="bottombar-row">
				<ConnectionStatus />
				<ToolPalette />
				<ChatDrawer />
			</div>
		</footer>
	</div>
{/if}

<style>
	.app {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		position: relative;
	}

	.topbar,
	.bottombar {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 5;
		pointer-events: none;
	}

	.topbar {
		top: 0;
		padding: 16px 18px;
		padding-top: max(16px, env(safe-area-inset-top));
	}

	.bottombar {
		bottom: 0;
		padding: 16px 18px;
		padding-bottom: max(16px, env(safe-area-inset-bottom));
	}

	.topbar-row,
	.bottombar-row {
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: 1200px;
		margin: 0 auto;
	}

	.bottombar-row {
		justify-content: space-between;
	}

	.bottombar-row :global(.palette) {
		margin: 0 auto;
	}

	.spacer {
		flex: 1;
	}

	/* Make every interactive element re-enable pointer events on the bars. */
	.topbar :global(button),
	.topbar :global(.share),
	.topbar :global(.stack),
	.topbar :global(.status),
	.bottombar :global(button),
	.bottombar :global(.share),
	.bottombar :global(.stack),
	.bottombar :global(.status),
	.bottombar :global(.palette),
	.bottombar :global(.wrap),
	.bottombar :global(.toggle) {
		pointer-events: auto;
	}

	.canvas {
		flex: 1;
		display: flex;
		min-height: 0;
		min-width: 0;
	}

	@media (max-width: 540px) {
		.topbar-row,
		.bottombar-row {
			gap: 6px;
		}
		.topbar :global(.code) {
			font-size: 13px;
		}
	}
</style>
