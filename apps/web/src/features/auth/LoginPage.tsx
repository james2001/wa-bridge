import { useState } from 'react';
import { useLoginMutation } from './authApi';

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = (err as { data?: unknown }).data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof (data as { message?: unknown }).message === 'string'
    ) {
      return (data as { message: string }).message;
    }
  }
  return fallback;
}

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [login, { isLoading }] = useLoginMutation();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (password.length === 0) {
      setLocalError('Mot de passe requis.');
      return;
    }
    try {
      // setCredentials est dispatché dans onQueryStarted -> l'app bascule
      // automatiquement vers l'écran de connexion WhatsApp.
      await login({ password }).unwrap();
    } catch (err) {
      setLocalError(errorMessage(err, 'Mot de passe incorrect.'));
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <div className="login__logo">W</div>
          <h1>wa-bridge</h1>
        </div>

        <form onSubmit={onSubmit} className="login__form">
          <label htmlFor="password">Mot de passe</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => {
              setLocalError(null);
              setPassword(e.target.value);
            }}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={isLoading}
          >
            {isLoading ? 'Connexion…' : 'Se connecter'}
          </button>
          <p className="login__hint">
            Mot de passe défini dans <code>.env</code> (<code>APP_PASSWORD</code>).
          </p>
        </form>

        {localError && <p className="login__error">{localError}</p>}
      </div>
    </div>
  );
}
