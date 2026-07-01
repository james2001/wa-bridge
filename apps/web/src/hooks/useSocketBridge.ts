import { useEffect } from 'react';
import type {
  WaAccountsResponse,
  WaChat,
  WaConnection,
  WaMessage,
  WaMessageStatus,
  WaPresence,
  WaReaction,
} from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectAccessToken } from '../features/auth/authSlice';
import {
  setAccounts,
  setConnection,
  setPresence,
} from '../features/whatsapp/waSlice';
import { setChats, upsertChat } from '../features/chats/chatsApi';
import {
  cacheKey,
  removeMessage,
  upsertMessage,
  updateMessageStatus,
  updateReactions,
} from '../features/messages/messagesApi';
import { api } from '../app/api';
import { connectSocket, disconnectSocket } from '../services/socket';

// Connecte le socket quand l'accessToken change et câble les événements
// serveur -> état Redux / cache RTK Query. Monté une fois (app authentifiée).
// Toutes les mises à jour de cache sont scopées au `accountId` porté par
// l'événement, y compris pour les comptes non affichés (leurs compteurs de
// non-lus restent à jour quand on y revient).
export function useSocketBridge(): void {
  const token = useAppSelector(selectAccessToken);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!token) {
      disconnectSocket();
      return;
    }

    const socket = connectSocket(token);

    const onAccounts = (p: WaAccountsResponse) => {
      dispatch(setAccounts(p));
    };
    const onConnection = (conn: WaConnection) => {
      dispatch(setConnection(conn));
    };
    const onChats = (p: { accountId: string; chats: WaChat[] }) => {
      dispatch(setChats(p.accountId, p.chats));
    };
    const onChatUpsert = (p: { accountId: string; chat: WaChat }) => {
      dispatch(upsertChat(p.accountId, p.chat));
    };
    const onMessage = (p: { accountId: string; message: WaMessage }) => {
      dispatch(upsertMessage(p.accountId, p.message.chatJid, p.message));
      // Reflète le nouveau dernier message / unread dans la liste du compte.
      dispatch(
        api.util.invalidateTags([{ type: 'WaChats', id: p.accountId }]),
      );
    };
    const onMessageStatus = (p: {
      accountId: string;
      id: string;
      chatJid: string;
      status: WaMessageStatus;
    }) => {
      dispatch(updateMessageStatus(p.accountId, p.chatJid, p.id, p.status));
    };
    const onMessageDeleted = (p: {
      accountId: string;
      id: string;
      chatJid: string;
    }) => {
      dispatch(removeMessage(p.accountId, p.chatJid, p.id));
    };
    const onReaction = (p: {
      accountId: string;
      chatJid: string;
      messageId: string;
      reactions: WaReaction[];
    }) => {
      dispatch(
        updateReactions(p.accountId, p.chatJid, p.messageId, p.reactions),
      );
    };
    const onPresence = (p: WaPresence) => {
      dispatch(setPresence(p));
    };
    const onHistorySynced = (p: {
      accountId: string;
      chatJid: string | null;
    }) => {
      dispatch(
        api.util.invalidateTags([{ type: 'WaChats', id: p.accountId }]),
      );
      if (p.chatJid) {
        dispatch(
          api.util.invalidateTags([
            { type: 'WaMessages', id: cacheKey(p.accountId, p.chatJid) },
          ]),
        );
      }
    };

    socket.on('wa:accounts', onAccounts);
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
      socket.off('wa:accounts', onAccounts);
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
