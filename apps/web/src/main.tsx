import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './app/store';
import App from './app/App';
import './styles/global.css';
import { applyTheme, initialTheme } from './lib/theme';
import { applyDensity } from './lib/density';

// Avant le premier rendu : pas de flash clair au chargement en thème sombre.
applyTheme(initialTheme());
applyDensity();

const container = document.getElementById('root');
if (!container) throw new Error('#root introuvable');

createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
);
