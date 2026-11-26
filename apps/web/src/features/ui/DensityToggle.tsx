import { setDensity, useDensity } from '../../lib/density';

// Bascule affichage normal / compact de la colonne de gauche.
export default function DensityToggle() {
  const compact = useDensity() === 'compact';
  return (
    <button
      type="button"
      className={'iconbtn' + (compact ? ' iconbtn--on' : '')}
      title={compact ? 'Affichage normal' : 'Affichage compact'}
      aria-label="Affichage compact de la liste"
      aria-pressed={compact}
      onClick={() => setDensity(compact ? 'normal' : 'compact')}
    >
      ☰
    </button>
  );
}
