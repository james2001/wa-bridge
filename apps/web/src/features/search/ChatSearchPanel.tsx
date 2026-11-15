import { useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '../../app/hooks';
import { useDebounced } from '../../hooks/useDebounced';
import { useSearchMessagesQuery } from '../chats/chatsApi';
import { setFocusMessage } from '../ui/uiSlice';
import SearchResults from './SearchResults';

interface Props {
  accountId: string;
  jid: string;
  onClose: () => void;
}

// Recherche dans les messages de la discussion ouverte (lecture seule).
export default function ChatSearchPanel({ accountId, jid, onClose }: Props) {
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { data, isFetching } = useSearchMessagesQuery(
    { accountId, q, chatJid: jid },
    { skip: q.length < 2 },
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="chatsearch">
      <div className="chatsearch__bar">
        <input
          ref={inputRef}
          type="search"
          placeholder="Rechercher dans la discussion"
          aria-label="Rechercher dans la discussion"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <button
          type="button"
          className="iconbtn"
          title="Fermer la recherche"
          aria-label="Fermer la recherche"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {q.length >= 2 && (
        <div className="chatsearch__results">
          <SearchResults
            messages={data}
            isFetching={isFetching}
            query={q}
            onPick={(m) => {
              dispatch(setFocusMessage({ chatJid: m.chatJid, id: m.id }));
              onClose();
            }}
          />
        </div>
      )}
    </div>
  );
}
