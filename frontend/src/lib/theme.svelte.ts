export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'collab-board-theme';

function detectInitial(): Theme {
	if (typeof window === 'undefined') return 'dark';
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === 'dark' || saved === 'light') return saved;
	} catch {
		// ignore — private mode etc.
	}
	const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
	return prefersLight ? 'light' : 'dark';
}

class ThemeState {
	current = $state<Theme>(detectInitial());

	apply(): void {
		if (typeof document !== 'undefined') {
			document.documentElement.dataset.theme = this.current;
		}
	}

	toggle(): void {
		this.current = this.current === 'dark' ? 'light' : 'dark';
		this.persist();
		this.apply();
	}

	private persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, this.current);
		} catch {
			// ignore
		}
	}
}

export const theme = new ThemeState();
theme.apply();
