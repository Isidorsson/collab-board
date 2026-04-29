import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// outDir is resolved relative to this config file, so the build emits
// directly into the Go embed target. emptyOutDir keeps `.gitkeep` since
// it lives in `cmd/server/web/dist/`, not in `frontend/dist/`.
export default defineConfig({
	plugins: [svelte()],
	build: {
		outDir: '../cmd/server/web/dist',
		emptyOutDir: true,
		sourcemap: false,
		target: 'es2022'
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			'/ws': {
				target: 'ws://localhost:8080',
				ws: true,
				changeOrigin: true
			},
			'/healthz': 'http://localhost:8080',
			'/metrics': 'http://localhost:8080'
		}
	}
});
