import { useAppSelector } from './hooks';
import ChatList from '../features/chats/ChatList';
import ChatView from '../features/chats/ChatView';
import ContactInfoPanel from '../features/chats/ContactInfoPanel';
import {
  selectSelectedChatJid,
  selectInfoPanelOpen,
} from '../features/ui/uiSlice';

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
  const infoOpen = useAppSelector(selectInfoPanelOpen);
  const showInfo = Boolean(selectedJid) && infoOpen;

  return (
    <div
      className={
        'layout' +
        (selectedJid ? ' layout--chat-open' : '') +
        (showInfo ? ' layout--info-open' : '')
      }
    >
      <ChatList />
      <main className="layout__main">
        {selectedJid ? (
          <ChatView key={selectedJid} jid={selectedJid} />
        ) : (
          <EmptyChat />
        )}
      </main>
      {showInfo && selectedJid && <ContactInfoPanel jid={selectedJid} />}
    </div>
  );
}
