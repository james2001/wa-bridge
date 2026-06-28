import { useEffect } from 'react';
import { useGetChatsQuery } from './chatsApi';
import ChatHeader from './ChatHeader';
import MessageList from '../messages/MessageList';
import Composer from '../messages/Composer';
import { markRead, subscribePresence } from '../../services/socket';

interface Props {
  jid: string;
}

export default function ChatView({ jid }: Props) {
  const { data: chats } = useGetChatsQuery();
  const chat = chats?.find((c) => c.jid === jid);

  // À l'ouverture d'une discussion: marquer comme lue + suivre la présence.
  useEffect(() => {
    markRead(jid);
    subscribePresence(jid);
  }, [jid]);

  return (
    <section className="chat">
      <ChatHeader chat={chat} jid={jid} />
      <MessageList jid={jid} />
      <Composer chatJid={jid} />
    </section>
  );
}
