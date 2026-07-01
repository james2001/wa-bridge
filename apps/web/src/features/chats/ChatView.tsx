import { useEffect } from 'react';
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

  // À l'ouverture d'une discussion: marquer comme lue + suivre la présence.
  useEffect(() => {
    markRead(accountId, jid);
    subscribePresence(accountId, jid);
  }, [accountId, jid]);

  return (
    <section className="chat">
      <ChatHeader chat={chat} jid={jid} accountId={accountId} />
      <MessageList jid={jid} accountId={accountId} />
      <Composer chatJid={jid} accountId={accountId} />
    </section>
  );
}
