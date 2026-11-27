import { useEffect } from 'react';
import { useAppDispatch } from '../../app/hooks';
import { useGetChatsQuery, useGetStarredQuery } from '../chats/chatsApi';
import { selectChat, setFocusMessage } from '../ui/uiSlice';
import SearchResults from './SearchResults';

interface Props {
  accountId: string;
  onClose: () => void;
}

// Liste des messages importants (étoile) du compte affiché.
export default function StarredModal({ accountId, onClose }: Props) {
  const dispatch = useAppDispatch();
  const { data, isFetching } = useGetStarredQuery(accountId);
  const { data: chats } = useGetChatsQuery(accountId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="addacct"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Messages importants"
    >
      <div className="addacct__box newchat" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="addacct__close"
          onClick={onClose}
          aria-label="Fermer"
        >
          ✕
        </button>
        <h2 className="addacct__title">Messages importants</h2>
        <div className="newchat__list">
          <SearchResults
            messages={data}
            isFetching={isFetching}
            query=""
            chats={chats}
            onPick={(m) => {
              dispatch(selectChat(m.chatJid));
              dispatch(setFocusMessage({ chatJid: m.chatJid, id: m.id }));
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
