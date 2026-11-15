// Thème clair / sombre. Choix mémorisé dans le navigateur ; sans choix, on
// suit le réglage du système. Appliqué via <html data-theme="..."> (cf.
// global.css).

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'wa-bridge.theme';

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // stockage bloqué (navigation privée…) : on suit le système
  }
}

export function initialTheme(): Theme {
  const stored = storedTheme();
  if (stored) return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* stockage indisponible : le choix vaut pour la session */
  }
}
