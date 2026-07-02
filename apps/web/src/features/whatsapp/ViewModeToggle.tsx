import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectAccounts } from './waSlice';
import { selectViewMode, setViewMode } from '../ui/uiSlice';

// Bascule « Comptes » <-> « Fusionné » de la barre latérale. Affichée uniquement
// en multi-compte (avec un seul compte, la vue fusionnée n'apporte rien).
export default function ViewModeToggle() {
  const dispatch = useAppDispatch();
  const accounts = useAppSelector(selectAccounts);
  const mode = useAppSelector(selectViewMode);

  if (accounts.length <= 1) return null;

  return (
    <div className="viewtoggle" role="tablist" aria-label="Mode d'affichage">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'account'}
        className={
          'viewtoggle__btn' + (mode === 'account' ? ' viewtoggle__btn--active' : '')
        }
        onClick={() => dispatch(setViewMode('account'))}
      >
        Comptes
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'merged'}
        className={
          'viewtoggle__btn' + (mode === 'merged' ? ' viewtoggle__btn--active' : '')
        }
        onClick={() => dispatch(setViewMode('merged'))}
      >
        Fusionné
      </button>
    </div>
  );
}
