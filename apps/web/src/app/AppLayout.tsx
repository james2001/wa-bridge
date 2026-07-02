import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './hooks';
import ChatList from '../features/chats/ChatList';
import ChatView from '../features/chats/ChatView';
import ContactInfoPanel from '../features/chats/ContactInfoPanel';
import PeopleList from '../features/people/PeopleList';
import PersonView from '../features/people/PersonView';
import { selectAccounts } from '../features/whatsapp/waSlice';
import {
  selectInfoPanelOpen,
  selectSelectedChatJid,
  selectSelectedPersonId,
  selectViewMode,
  setViewMode,
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
  const dispatch = useAppDispatch();
  const viewMode = useAppSelector(selectViewMode);
  const accounts = useAppSelector(selectAccounts);
  const selectedJid = useAppSelector(selectSelectedChatJid);
  const selectedPersonId = useAppSelector(selectSelectedPersonId);
  const infoOpen = useAppSelector(selectInfoPanelOpen);

  const merged = viewMode === 'merged';

  // La vue fusionnée n'a de sens qu'en multi-compte: si on retombe à ≤1 compte
  // (suppression), on rebascule sur les discussions par compte.
  useEffect(() => {
    if (merged && accounts.length <= 1) {
      dispatch(setViewMode('account'));
    }
  }, [merged, accounts.length, dispatch]);

  // Le volet « Infos » n'existe qu'en mode par compte (v1).
  const showInfo = !merged && Boolean(selectedJid) && infoOpen;
  const selected = merged ? selectedPersonId : selectedJid;

  return (
    <div
      className={
        'layout' +
        (selected ? ' layout--chat-open' : '') +
        (showInfo ? ' layout--info-open' : '')
      }
    >
      {merged ? <PeopleList /> : <ChatList />}
      <main className="layout__main">
        {merged ? (
          selectedPersonId ? (
            <PersonView key={selectedPersonId} jid={selectedPersonId} />
          ) : (
            <EmptyChat />
          )
        ) : selectedJid ? (
          <ChatView key={selectedJid} jid={selectedJid} />
        ) : (
          <EmptyChat />
        )}
      </main>
      {showInfo && selectedJid && <ContactInfoPanel jid={selectedJid} />}
    </div>
  );
}
