import { useState } from 'react';
import { useAppDispatch } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { leaveGroup } from '../../services/socket';
import { useGetGroupInfoQuery } from './chatsApi';
import { prettyJid } from './utils';
import { closeInfoPanel } from '../ui/uiSlice';

interface Props {
  accountId: string;
  jid: string;
  title: string;
}

// Panneau d'infos d'un groupe : description, participants (admins marqués),
// et « Quitter le groupe » derrière une confirmation explicite.
export default function GroupInfoSection({ accountId, jid, title }: Props) {
  const dispatch = useAppDispatch();
  const { data, isLoading, isError } = useGetGroupInfoQuery({ accountId, jid });
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLeave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await leaveGroup(accountId, jid);
      if (ack.ok) {
        setConfirmLeave(false);
        dispatch(closeInfoPanel());
      } else {
        setError(ack.error ?? 'Échec');
      }
    } catch {
      setError('WhatsApp injoignable, vous êtes toujours dans le groupe');
    }
    setBusy(false);
  };

  return (
    <>
      {data?.description && (
        <section className="infopanel__about">
          <div className="infopanel__media-head">
            <span>Description</span>
          </div>
          <p className="infopanel__about-text">{data.description}</p>
        </section>
      )}

      <section className="infopanel__about">
        <div className="infopanel__media-head">
          <span>Participants</span>
          <span className="infopanel__media-count">
            {data?.participants.length ?? ''}
          </span>
        </div>
        {isLoading && <p className="search__empty">Chargement…</p>}
        {isError && (
          <p className="search__empty">Impossible de charger les participants.</p>
        )}
        <ul className="grp__list">
          {data?.participants.map((p) => (
            <li key={p.jid} className="grp__item">
              <Avatar
                name={p.name ?? prettyJid(p.jid)}
                jid={p.jid}
                // Pas de photo : un grand groupe déclencherait des centaines
                // de requêtes de photo de profil vers WhatsApp.
                avatarUrl={null}
                accountId={accountId}
                size="sm"
              />
              <span className="grp__name">
                {p.isMe ? 'Vous' : (p.name ?? prettyJid(p.jid))}
              </span>
              {p.admin && (
                <span className="grp__admin">
                  {p.admin === 'superadmin' ? 'Créateur' : 'Admin'}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="infopanel__actions">
        <button
          type="button"
          className="infopanel__block"
          onClick={() => {
            setError(null);
            setConfirmLeave(true);
          }}
        >
          Quitter le groupe
        </button>
      </section>

      {confirmLeave && (
        <div
          className="addacct"
          onClick={() => !busy && setConfirmLeave(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Quitter le groupe"
        >
          <div className="addacct__box delmsg" onClick={(e) => e.stopPropagation()}>
            <h2 className="addacct__title">Quitter le groupe ?</h2>
            <p className="delmsg__excerpt">« {title} »</p>
            <p className="delmsg__hint">
              Les membres verront que vous êtes parti. Pour revenir, un
              administrateur devra vous ajouter à nouveau.
            </p>
            {error && (
              <p className="delmsg__error" role="alert">
                {error}
              </p>
            )}
            <div className="delmsg__actions">
              <button
                type="button"
                className="btn btn--sm delmsg__danger"
                disabled={busy}
                onClick={() => void doLeave()}
              >
                Quitter le groupe
              </button>
              <button
                type="button"
                className="btn btn--sm delmsg__cancel"
                disabled={busy}
                autoFocus
                onClick={() => setConfirmLeave(false)}
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
