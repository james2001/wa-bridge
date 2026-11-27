import { useEffect, useMemo, useRef, useState } from 'react';
import type { WaChat, WaMessage } from '@app/shared-types';
import Avatar from '../../components/Avatar';
import { forwardMessage } from '../../services/socket';
import { useGetChatsQuery } from '../chats/chatsApi';
import { chatTitle, prettyJid } from '../chats/utils';

interface Props {
  message: WaMessage;
  onClose: () => void;
}

// Transférer un message : UN destinataire à la fois, choisi parmi les
// discussions, puis une étape de confirmation explicite avant l'envoi.
export default function ForwardModal({ message, onClose }: Props) {
  const { data: chats } = useGetChatsQuery(message.accountId);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<WaChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const q = query.trim().toLowerCase();
  const list = useMemo(
    () =>
      (chats ?? [])
        .filter((c) => !c.archived || q)
        .filter(
          (c) =>
            !q ||
            chatTitle(c).toLowerCase().includes(q) ||
            prettyJid(c.jid).toLowerCase().includes(q),
        )
        .slice(0, 50),
    [chats, q],
  );

  const excerpt = message.text
    ? message.text.length > 80
      ? message.text.slice(0, 77) + '…'
      : message.text
    : message.media
      ? 'Média'
      : 'Message';

  const send = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await forwardMessage(
        message.accountId,
        message.chatJid,
        message.id,
        target.jid,
      );
      if (ack.ok) {
        onClose();
        return;
      }
      setError(ack.error ?? 'Échec du transfert');
    } catch {
      // Délai dépassé : l'envoi a PU partir — ne pas renvoyer à l'aveugle.
      setError(
        'Pas de réponse du serveur. Vérifiez la discussion avant de réessayer : le message est peut-être déjà parti.',
      );
    }
    setBusy(false);
  };

  return (
    <div
      className="addacct"
      onClick={() => !busy && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Transférer le message"
    >
      <div className="addacct__box newchat" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="addacct__close"
          onClick={onClose}
          disabled={busy}
          aria-label="Fermer"
        >
          ✕
        </button>
        <h2 className="addacct__title">Transférer le message</h2>
        <p className="delmsg__excerpt">« {excerpt} »</p>

        {!target ? (
          <>
            <input
              ref={inputRef}
              type="search"
              className="newchat__search"
              placeholder="Rechercher une discussion"
              aria-label="Rechercher une discussion"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="newchat__list">
              {list.length === 0 && (
                <p className="newchat__empty">Aucune discussion.</p>
              )}
              <ul>
                {list.map((c) => (
                  <li key={c.jid}>
                    <button
                      type="button"
                      className="newchat__item"
                      onClick={() => setTarget(c)}
                    >
                      <Avatar
                        name={chatTitle(c)}
                        jid={c.jid}
                        avatarUrl={c.avatarUrl}
                        accountId={c.accountId}
                        size="sm"
                      />
                      <span className="newchat__text">
                        <span className="newchat__name">{chatTitle(c)}</span>
                        <span className="newchat__num">
                          {c.isGroup ? 'Groupe' : prettyJid(c.jid)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <>
            <p className="delmsg__hint">
              Destinataire : <strong>{chatTitle(target)}</strong>
              {target.isGroup ? ' (groupe : tous les membres le verront)' : ''}
            </p>
            {error && (
              <p className="delmsg__error" role="alert">
                {error}
              </p>
            )}
            <div className="delmsg__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy}
                onClick={() => void send()}
              >
                {busy ? 'Transfert…' : 'Transférer'}
              </button>
              <button
                type="button"
                className="btn btn--sm delmsg__cancel"
                disabled={busy}
                autoFocus
                onClick={() => {
                  setTarget(null);
                  setError(null);
                }}
              >
                Changer de destinataire
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
