import { useSyncExternalStore } from 'react';

// Affichage de la colonne de gauche : normal, ou compact pour les petits
// écrans (en-tête sur une ligne, discussions plus serrées). Choix mémorisé
// dans le navigateur, appliqué via <html data-density="..."> (cf. global.css).

export type Density = 'normal' | 'compact';

const STORAGE_KEY = 'wa-bridge.density';
const listeners = new Set<() => void>();

function stored(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'normal';
  } catch {
    return 'normal'; // stockage bloqué : affichage normal
  }
}

let current: Density = stored();

export function applyDensity(): void {
  document.documentElement.dataset.density = current;
}

export function setDensity(d: Density): void {
  current = d;
  applyDensity();
  try {
    localStorage.setItem(STORAGE_KEY, d);
  } catch {
    /* stockage indisponible : le choix vaut pour la session */
  }
  for (const l of listeners) l();
}

export function useDensity(): Density {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
