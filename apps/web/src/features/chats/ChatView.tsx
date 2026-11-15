import { useEffect, useState } from 'react';
import ChatSearchPanel from '../search/ChatSearchPanel';
import { useAppSelector } from '../../app/hooks';
import { selectActiveAccountId } from '../ui/uiSlice';
import { useGetChatsQuery } from './chatsApi';
import ChatHeader from './ChatHeader';
import MessageList from '../messages/MessageList';
import Composer from '../messages/Composer';
import { markRead, subscribePresence } from '../../services/socket';

interface Props {
  jid: string;
}

export default function ChatView({ jid }: Props) {
  const accountId = useAppSelector(selectActiveAccountId);
  const { data: chats } = useGetChatsQuery(accountId);
  const chat = chats?.find((c) => c.jid === jid);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setSearchOpen(false), [jid]);

  // À l'ouverture d'une discussion: marquer comme lue + suivre la présence.
  useEffect(() => {
    markRead(accountId, jid);
    subscribePresence(accountId, jid);
  }, [accountId, jid]);

  return (
    <section className="chat">
      <ChatHeader
        chat={chat}
        jid={jid}
        accountId={accountId}
        onSearch={() => setSearchOpen((v) => !v)}
      />
      {searchOpen && (
        <ChatSearchPanel
          accountId={accountId}
          jid={jid}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <MessageList jid={jid} accountId={accountId} />
      {/* key : une saisie neuve par discussion (un texte en cours ne doit
          jamais passer d'un contact à un autre). */}
      <Composer key={`${accountId}|${jid}`} chatJid={jid} accountId={accountId} />
    </section>
  );
}
