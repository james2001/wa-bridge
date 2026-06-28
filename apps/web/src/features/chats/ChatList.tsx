import { useMemo, useState } from 'react';
import type { WaChat } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { initials, formatChatTime } from '../../lib/format';
import Avatar from '../../components/Avatar';
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
  const [showArchived, setShowArchived] = useState(false);

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

  const active = useMemo(() => sorted.filter((c) => !c.archived), [sorted]);
  const archived = useMemo(() => sorted.filter((c) => c.archived), [sorted]);

  const renderItem = (c: WaChat) => {
    const title = chatTitle(c);
    return (
      <button
        key={c.jid}
        className={
          'convitem' + (c.jid === selectedJid ? ' convitem--active' : '')
        }
        onClick={() => dispatch(selectChat(c.jid))}
      >
        <Avatar name={title} jid={c.jid} avatarUrl={c.avatarUrl} />
        <div className="convitem__body">
          <div className="convitem__top">
            <span className="convitem__title">
              {c.muted && (
                <span className="convitem__muted" title="Notifications coupées">
                  🔇
                </span>
              )}
              {title}
            </span>
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
  };

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

        {archived.length > 0 && (
          <button
            className="archived-toggle"
            onClick={() => setShowArchived((v) => !v)}
          >
            <span className="archived-toggle__icon">🗄</span>
            <span className="archived-toggle__label">
              Archivées ({archived.length})
            </span>
            <span className="archived-toggle__chevron">
              {showArchived ? '▾' : '▸'}
            </span>
          </button>
        )}
        {showArchived && archived.map(renderItem)}

        {active.map(renderItem)}
      </div>
    </aside>
  );
}
