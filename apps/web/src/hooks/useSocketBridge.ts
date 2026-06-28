import { useEffect } from 'react';
import type {
  WaChat,
  WaConnection,
  WaMessage,
  WaMessageStatus,
  WaPresence,
  WaReaction,
} from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectAccessToken } from '../features/auth/authSlice';
import { setConnection, setPresence } from '../features/whatsapp/waSlice';
import { setChats, upsertChat } from '../features/chats/chatsApi';
import {
  removeMessage,
  upsertMessage,
  updateMessageStatus,
  updateReactions,
} from '../features/messages/messagesApi';
import { api } from '../app/api';
import { connectSocket, disconnectSocket } from '../services/socket';

// Connecte le socket quand l'accessToken change et câble les événements
// serveur -> état Redux / cache RTK Query. Monté une fois (app authentifiée).
export function useSocketBridge(): void {
  const token = useAppSelector(selectAccessToken);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!token) {
      disconnectSocket();
      return;
    }

    const socket = connectSocket(token);

    const onConnection = (conn: WaConnection) => {
      dispatch(setConnection(conn));
    };
    const onChats = (p: { chats: WaChat[] }) => {
      dispatch(setChats(p.chats));
    };
    const onChatUpsert = (p: { chat: WaChat }) => {
      dispatch(upsertChat(p.chat));
    };
    const onMessage = (p: { message: WaMessage }) => {
      dispatch(upsertMessage(p.message.chatJid, p.message));
      // Reflète le nouveau dernier message / unread dans la liste.
      dispatch(api.util.invalidateTags(['WaChats']));
    };
    const onMessageStatus = (p: {
      id: string;
      chatJid: string;
      status: WaMessageStatus;
    }) => {
      dispatch(updateMessageStatus(p.chatJid, p.id, p.status));
    };
    const onMessageDeleted = (p: { id: string; chatJid: string }) => {
      dispatch(removeMessage(p.chatJid, p.id));
    };
    const onReaction = (p: {
      chatJid: string;
      messageId: string;
      reactions: WaReaction[];
    }) => {
      dispatch(updateReactions(p.chatJid, p.messageId, p.reactions));
    };
    const onPresence = (p: WaPresence) => {
      dispatch(setPresence(p));
    };
    const onHistorySynced = (p: { chatJid: string | null }) => {
      dispatch(api.util.invalidateTags(['WaChats']));
      if (p.chatJid) {
        dispatch(
          api.util.invalidateTags([{ type: 'WaMessages', id: p.chatJid }]),
        );
      }
    };

    socket.on('wa:connection', onConnection);
    socket.on('wa:chats', onChats);
    socket.on('wa:chat-upsert', onChatUpsert);
    socket.on('wa:message', onMessage);
    socket.on('wa:message-status', onMessageStatus);
    socket.on('wa:message-deleted', onMessageDeleted);
    socket.on('wa:reaction', onReaction);
    socket.on('wa:presence', onPresence);
    socket.on('wa:history-synced', onHistorySynced);

    return () => {
      socket.off('wa:connection', onConnection);
      socket.off('wa:chats', onChats);
      socket.off('wa:chat-upsert', onChatUpsert);
      socket.off('wa:message', onMessage);
      socket.off('wa:message-status', onMessageStatus);
      socket.off('wa:message-deleted', onMessageDeleted);
      socket.off('wa:reaction', onReaction);
      socket.off('wa:presence', onPresence);
      socket.off('wa:history-synced', onHistorySynced);
    };
  }, [token, dispatch]);
}
