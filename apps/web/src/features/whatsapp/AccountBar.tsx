import { ConnectionState } from '@app/shared-types';
import type { WaAccount, WaConnection } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import {
  selectAccounts,
  selectConnections,
  selectDefaultAccountId,
} from './waSlice';
import { selectActiveAccountId, setActiveAccount } from '../ui/uiSlice';
import { deleteAccount } from '../../services/socket';

interface Props {
  onAdd: () => void;
}

// Couleur de la pastille de statut d'un compte selon l'état de connexion.
function statusColor(conn: WaConnection | undefined): string {
  switch (conn?.state) {
    case ConnectionState.OPEN:
      return '#25D366'; // lié
    case ConnectionState.QR:
    case ConnectionState.CONNECTING:
      return '#F1C40F'; // en cours
    default:
      return '#B0B7BD'; // hors ligne / à lier
  }
}

// Barre de comptes (multi-compte) : bascule d'un compte à l'autre + ajout.
// Compacte quand un seul compte (juste « + Ajouter un compte »).
export default function AccountBar({ onAdd }: Props) {
  const dispatch = useAppDispatch();
  const accounts = useAppSelector(selectAccounts);
  const connections = useAppSelector(selectConnections);
  const activeAccountId = useAppSelector(selectActiveAccountId);
  const defaultAccountId = useAppSelector(selectDefaultAccountId);

  const onDelete = async (acc: WaAccount) => {
    if (
      !window.confirm(
        `Délier et supprimer « ${acc.label} » ? Ses discussions locales seront effacées.`,
      )
    ) {
      return;
    }
    try {
      const ack = await deleteAccount(acc.id);
      if (ack.ok && activeAccountId === acc.id) {
        dispatch(setActiveAccount(defaultAccountId));
      }
    } catch {
      /* le socket resynchronisera la liste */
    }
  };

  // Un seul compte : simple bouton d'ajout discret.
  if (accounts.length <= 1) {
    return (
      <div className="acctbar acctbar--single">
        <button type="button" className="acctbar__add" onClick={onAdd}>
          + Ajouter un compte
        </button>
      </div>
    );
  }

  return (
    <div className="acctbar">
      {accounts.map((acc) => {
        const active = acc.id === activeAccountId;
        return (
          <div
            key={acc.id}
            className={'acctchip' + (active ? ' acctchip--active' : '')}
            style={
              active && acc.color
                ? { borderColor: acc.color }
                : undefined
            }
          >
            <button
              type="button"
              className="acctchip__main"
              aria-pressed={active}
              onClick={() => dispatch(setActiveAccount(acc.id))}
              title={acc.label}
            >
              <span
                className="acctchip__dot"
                style={{ background: statusColor(connections[acc.id]) }}
              />
              <span className="acctchip__label">{acc.label}</span>
            </button>
            {!acc.isDefault && (
              <button
                type="button"
                className="acctchip__del"
                title="Délier ce compte"
                aria-label={`Délier ${acc.label}`}
                onClick={() => void onDelete(acc)}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="acctbar__add acctbar__add--icon"
        title="Ajouter un compte"
        aria-label="Ajouter un compte"
        onClick={onAdd}
      >
        +
      </button>
    </div>
  );
}
