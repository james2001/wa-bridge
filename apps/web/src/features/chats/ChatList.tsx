import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { initials, formatChatTime } from '../../lib/format';
import { useGetChatsQuery } from './chatsApi';
import { chatTitle, prettyJid } from './utils';
import { selectChat, selectSelectedChatJid } from '../ui/uiSlice';
import { selectConnection } from '../whatsapp/waSlice';
import { useLogoutMutation } from '../auth/authApi';

export default function ChatList() {
  const dispatch = useAppDispatch();
  const { data: chats, isLoading, isError } = useGetChatsQuery();
  const selectedJid = useAppSelector(selectSelectedChatJid);
  const connection = useAppSelector(selectConnection);
  const [logout] = useLogoutMutation();

  const meName =
    connection.me?.name ||
    (connection.me ? prettyJid(connection.me.jid) : 'Moi');

  const sorted = useMemo(
    () =>
      chats
        ? [...chats].sort(
            (a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0),
          )
        : [],
    [chats],
  );

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <div className="sidebar__me">
          <div className="avatar avatar--sm">{initials(meName)}</div>
          <span>{meName}</span>
        </div>
        <div className="sidebar__actions">
          <button
            className="iconbtn"
            title="Se déconnecter"
            onClick={() => {
              void logout();
            }}
          >
            ⎋
          </button>
        </div>
      </header>

      <div className="sidebar__list">
        {isLoading && <p className="sidebar__empty">Chargement…</p>}
        {isError && (
          <p className="sidebar__empty">
            Impossible de charger les discussions.
          </p>
        )}
        {!isLoading && sorted.length === 0 && (
          <p className="sidebar__empty">Aucune discussion pour le moment.</p>
        )}
        {sorted.map((c) => {
          const title = chatTitle(c);
          return (
            <button
              key={c.jid}
              className={
                'convitem' + (c.jid === selectedJid ? ' convitem--active' : '')
              }
              onClick={() => dispatch(selectChat(c.jid))}
            >
              <div className="avatar">
                {c.avatarUrl ? (
                  <img src={c.avatarUrl} alt="" />
                ) : (
                  initials(title)
                )}
              </div>
              <div className="convitem__body">
                <div className="convitem__top">
                  <span className="convitem__title">{title}</span>
                  <span className="convitem__time">
                    {formatChatTime(c.lastMessageTs)}
                  </span>
                </div>
                <div className="convitem__bottom">
                  <span className="convitem__preview">
                    {c.lastMessagePreview ?? ''}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="badge">{c.unreadCount}</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
