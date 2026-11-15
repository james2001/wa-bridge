import { useEffect, useRef, useState } from 'react';
import type { WaChat } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import {
  archiveChat,
  deleteChat,
  markRead,
  markUnread,
  muteChat,
  pinChat,
} from '../../services/socket';
import { selectChat, selectSelectedChatJid } from '../ui/uiSlice';
import { chatTitle } from './utils';

interface Props {
  chat: WaChat;
  pinnedCount: number;
}

const MAX_PINNED = 3;

// Menu « ⌄ » d'une discussion dans la liste (comme WhatsApp Web).
export default function ChatItemMenu({ chat, pinnedCount }: Props) {
  const dispatch = useAppDispatch();
  const selectedJid = useAppSelector(selectSelectedChatJid);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = chat.unreadCount > 0 || chat.unreadCount === -1;
  const pinFull = !chat.pinned && pinnedCount >= MAX_PINNED;
  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await deleteChat(chat.accountId, chat.jid);
      if (ack.ok) {
        if (selectedJid === chat.jid) dispatch(selectChat(null));
        setConfirmDelete(false);
      } else {
        setError(ack.error ?? 'Échec de la suppression');
      }
    } catch {
      setError('WhatsApp injoignable, rien n’a été supprimé');
    }
    setBusy(false);
  };

  return (
    <div className="chatmenu" ref={ref}>
      <button
        type="button"
        className="chatmenu__trigger"
        title="Options de la discussion"
        aria-label="Options de la discussion"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⌄
      </button>
      {open && (
        <ul className="chatmenu__list" role="menu">
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                run(() =>
                  unread
                    ? markRead(chat.accountId, chat.jid)
                    : markUnread(chat.accountId, chat.jid),
                )
              }
            >
              {unread ? 'Marquer comme lu' : 'Marquer comme non lu'}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              disabled={pinFull}
              title={pinFull ? `Déjà ${MAX_PINNED} discussions épinglées` : undefined}
              onClick={() => run(() => pinChat(chat.accountId, chat.jid, !chat.pinned))}
            >
              {chat.pinned ? 'Désépingler' : 'Épingler'}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => muteChat(chat.accountId, chat.jid, !chat.muted))}
            >
              {chat.muted ? 'Réactiver les notifications' : 'Couper les notifications'}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                run(() => archiveChat(chat.accountId, chat.jid, !chat.archived))
              }
            >
              {chat.archived ? 'Désarchiver' : 'Archiver'}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="chatmenu__danger"
              onClick={() => {
                setOpen(false);
                setError(null);
                setConfirmDelete(true);
              }}
            >
              Supprimer la discussion
            </button>
          </li>
        </ul>
      )}
      {confirmDelete && (
        <div
          className="addacct"
          onClick={() => !busy && setConfirmDelete(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Supprimer la discussion"
        >
          <div
            className="addacct__box delmsg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="addacct__title">Supprimer la discussion ?</h2>
            <p className="delmsg__excerpt">« {chatTitle(chat)} »</p>
            <p className="delmsg__hint">
              Les messages disparaissent de wa-bridge et de vos appareils.
              Votre contact n’en voit rien.
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
                onClick={() => void doDelete()}
              >
                Supprimer la discussion
              </button>
              <button
                type="button"
                className="btn btn--sm delmsg__cancel"
                disabled={busy}
                autoFocus
                onClick={() => setConfirmDelete(false)}
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
