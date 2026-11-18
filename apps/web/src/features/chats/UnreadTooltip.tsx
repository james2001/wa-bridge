import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WaChat } from '@app/shared-types';
import { formatChatTime, formatTime } from '../../lib/format';
import { useGetUnreadPreviewQuery } from './chatsApi';

interface Props {
  chat: WaChat;
  anchor: DOMRect; // rectangle de l'élément survolé dans la liste
}

const WIDTH = 340;

function when(ts: number): string {
  const day = formatChatTime(ts);
  const time = formatTime(ts);
  return day === time ? time : `${day} ${time}`;
}

// Info-bulle de survol d'une discussion : ses derniers messages non lus.
// Lecture seule — l'afficher ne marque rien comme lu.
export default function UnreadTooltip({ chat, anchor }: Props) {
  const { data, isError } = useGetUnreadPreviewQuery({
    accountId: chat.accountId,
    jid: chat.jid,
    count: chat.unreadCount,
    lastTs: chat.lastMessageTs ?? null,
  });
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(anchor.top);

  // Reste dans la fenêtre : remonte la bulle si elle déborde en bas.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - h - 8)));
  }, [anchor.top, data, isError]);

  const left = Math.max(
    8,
    Math.min(anchor.right + 8, window.innerWidth - WIDTH - 8),
  );
  const messages = data?.messages ?? [];
  const total = data?.total ?? chat.unreadCount;

  let head = `${total} message${total > 1 ? 's' : ''} non lu${total > 1 ? 's' : ''}`;
  if (messages.length > 0 && messages.length < total) {
    head = `${messages.length} derniers sur ${total} non lus`;
  }

  return createPortal(
    <div
      ref={ref}
      className="unreadtip"
      role="tooltip"
      style={{ top, left, width: WIDTH }}
    >
      <div className="unreadtip__head">{head}</div>
      {isError ? (
        <p className="unreadtip__empty">Aperçu indisponible.</p>
      ) : !data ? (
        <p className="unreadtip__empty">Chargement…</p>
      ) : messages.length === 0 ? (
        <p className="unreadtip__empty">
          Messages non enregistrés dans wa-bridge.
        </p>
      ) : (
        <ul className="unreadtip__list">
          {messages.map((m) => (
            <li key={m.id} className="unreadtip__item">
              <span className="unreadtip__meta">
                {m.senderName && (
                  <span className="unreadtip__sender">{m.senderName}</span>
                )}
                <span className="unreadtip__time">{when(m.timestamp)}</span>
              </span>
              <span className="unreadtip__text">{m.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
