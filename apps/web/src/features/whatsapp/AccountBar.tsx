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
  onRelink: (acc: WaAccount) => void;
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
export default function AccountBar({ onAdd, onRelink }: Props) {
  const dispatch = useAppDispatch();
  const accounts = useAppSelector(selectAccounts);
  const connections = useAppSelector(selectConnections);
  const activeAccountId = useAppSelector(selectActiveAccountId);
  const defaultAccountId = useAppSelector(selectDefaultAccountId);

  // Re-liaison (nouveau QR) : conserve les discussions locales, contrairement
  // à la suppression. Disponible pour TOUS les comptes, y compris le principal
  // — c'est la porte de sortie quand une session est corrompue.
  const onRelinkClick = (acc: WaAccount) => {
    if (
      !window.confirm(
        `Re-lier « ${acc.label} » ? La session WhatsApp actuelle sera déliée, puis un QR à scanner apparaîtra. Les discussions locales sont conservées.`,
      )
    ) {
      return;
    }
    onRelink(acc);
  };

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

  // Un seul compte : bouton d'ajout discret + re-liaison du compte unique.
  if (accounts.length <= 1) {
    const only = accounts[0];
    return (
      <div className="acctbar acctbar--single">
        <button type="button" className="acctbar__add" onClick={onAdd}>
          + Ajouter un compte
        </button>
        {only && (
          <button
            type="button"
            className="acctbar__add"
            title="Re-lier ce compte (nouveau QR)"
            onClick={() => onRelinkClick(only)}
          >
            ↻ Re-lier
          </button>
        )}
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
            <button
              type="button"
              className="acctchip__relink"
              title="Re-lier ce compte (nouveau QR)"
              aria-label={`Re-lier ${acc.label}`}
              onClick={() => onRelinkClick(acc)}
            >
              ↻
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
