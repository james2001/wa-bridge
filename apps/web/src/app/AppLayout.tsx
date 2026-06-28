import { useAppSelector } from './hooks';
import ChatList from '../features/chats/ChatList';
import ChatView from '../features/chats/ChatView';
import { selectSelectedChatJid } from '../features/ui/uiSlice';

function EmptyChat() {
  return (
    <div className="empty">
      <div className="empty__logo">W</div>
      <h2>wa-bridge</h2>
      <p>Sélectionnez une discussion pour commencer à discuter.</p>
    </div>
  );
}

export default function AppLayout() {
  const selectedJid = useAppSelector(selectSelectedChatJid);

  return (
    <div className={'layout' + (selectedJid ? ' layout--chat-open' : '')}>
      <ChatList />
      <main className="layout__main">
        {selectedJid ? (
          <ChatView key={selectedJid} jid={selectedJid} />
        ) : (
          <EmptyChat />
        )}
      </main>
    </div>
  );
}
