import type { WaChat, WaMessage } from '@app/shared-types';
import { formatChatTime } from '../../lib/format';
import { chatTitle } from '../chats/utils';

interface Props {
  messages: WaMessage[] | undefined;
  isFetching: boolean;
  query: string;
  // Fourni pour la recherche globale : nom de la discussion de chaque résultat.
  chats?: WaChat[];
  onPick: (m: WaMessage) => void;
}

// Extrait centré sur la première occurrence, occurrence surlignée.
function Snippet({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return <>{text.slice(0, 120)}</>;
  const start = Math.max(0, i - 40);
  return (
    <>
      {start > 0 ? '…' : ''}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length, i + query.length + 80)}
    </>
  );
}

export default function SearchResults({ messages, isFetching, query, chats, onPick }: Props) {
  const byJid = new Map((chats ?? []).map((c) => [c.jid, c]));
  if (isFetching && !messages) return <p className="search__empty">Recherche…</p>;
  if (!messages || messages.length === 0) {
    return <p className="search__empty">Aucun message.</p>;
  }
  return (
    <ul className="search__list">
      {messages.map((m) => {
        const chat = byJid.get(m.chatJid);
        return (
          <li key={`${m.chatJid}|${m.id}`}>
            <button type="button" className="search__item" onClick={() => onPick(m)}>
              <span className="search__top">
                <span className="search__who">
                  {chats ? (chat ? chatTitle(chat) : m.chatJid.split('@')[0]) : ''}
                  {chats ? ' · ' : ''}
                  {m.fromMe ? 'Vous' : (m.senderName ?? '')}
                </span>
                <span className="search__date">{formatChatTime(m.timestamp)}</span>
              </span>
              <span className="search__text">
                <Snippet text={m.text ?? ''} query={query} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
