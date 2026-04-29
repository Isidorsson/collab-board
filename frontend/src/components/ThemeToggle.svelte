<script lang="ts">
	import { theme } from '../lib/theme.svelte';

	let isDark = $derived(theme.current === 'dark');
</script>

<button
	type="button"
	class="icon-btn"
	aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
	aria-pressed={isDark}
	onclick={() => theme.toggle()}
>
	{#if isDark}
		<!-- moon -->
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<path
				d="M14.5 12.5a6 6 0 0 1-7-7A6 6 0 1 0 14.5 12.5z"
				fill="currentColor"
			/>
		</svg>
	{:else}
		<!-- sun -->
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<circle cx="10" cy="10" r="3.5" fill="currentColor" />
			<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
				<line x1="10" y1="2" x2="10" y2="4" />
				<line x1="10" y1="16" x2="10" y2="18" />
				<line x1="2" y1="10" x2="4" y2="10" />
				<line x1="16" y1="10" x2="18" y2="10" />
				<line x1="4.4" y1="4.4" x2="5.8" y2="5.8" />
				<line x1="14.2" y1="14.2" x2="15.6" y2="15.6" />
				<line x1="4.4" y1="15.6" x2="5.8" y2="14.2" />
				<line x1="14.2" y1="5.8" x2="15.6" y2="4.4" />
			</g>
		</svg>
	{/if}
</button>
