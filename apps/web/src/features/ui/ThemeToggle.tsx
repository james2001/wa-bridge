import { useState } from 'react';
import { type Theme, saveTheme } from '../../lib/theme';

// Bascule clair / sombre (en-tête de la barre latérale).
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) ?? 'light',
  );
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="iconbtn"
      title={next === 'dark' ? 'Thème sombre' : 'Thème clair'}
      aria-label={next === 'dark' ? 'Passer au thème sombre' : 'Passer au thème clair'}
      onClick={() => {
        saveTheme(next);
        setTheme(next);
      }}
    >
      {next === 'dark' ? '🌙' : '☀️'}
    </button>
  );
}
