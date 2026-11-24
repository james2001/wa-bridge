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
import {
  chatsApi,
  patchChatLastMessage,
  setChats,
  updateChatLastStatus,
  upsertChat,
} from '../features/chats/chatsApi';
import { store } from '../app/store';
import { notifyIncoming } from '../lib/notify';
import {
  selectChat,
  setActiveAccount,
  setViewMode,
} from '../features/ui/uiSlice';
import {
  cacheKey,
  removeMessage,
  upsertMessage,
  updateMessageStatus,
  updateReactions,
} from '../features/messages/messagesApi';
import {
  personKey,
  removePersonMessage,
  upsertPersonMessage,
  updatePersonMessageStatus,
  updatePersonReactions,
} from '../features/people/peopleApi';
import { api } from '../app/api';
import {
  connectSocket,
  disconnectSocket,
  setClientActive,
} from '../services/socket';
import { PresenceKind } from '@app/shared-types';

// Sans clic ni frappe depuis ce délai, l'onglet ne compte plus comme utilisé.
const IDLE_MS = 3 * 60_000;

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
      // Boîte fusionnée: la synchro d'une liste change aperçus / non-lus / personnes.
      dispatch(api.util.invalidateTags([{ type: 'People', id: 'LIST' }]));
    };
    const onChatUpsert = (p: { accountId: string; chat: WaChat }) => {
      dispatch(upsertChat(p.accountId, p.chat));
      // Reflète non-lus (lecture depuis le téléphone) / mute / archive / nom /
      // aperçu de la personne dans la boîte fusionnée.
      dispatch(api.util.invalidateTags([{ type: 'People', id: 'LIST' }]));
      // Un groupe rattaché à une communauté -> la liste des communautés a pu
      // changer (backfill à la connexion). Rafraîchit l'en-tête de regroupement.
      if (p.chat.communityJid) {
        dispatch(
          api.util.invalidateTags([
            { type: 'WaCommunities', id: p.accountId },
          ]),
        );
      }
    };
    // Une communauté a changé (création / renommage) -> refetch de la liste.
    const onCommunity = (p: { accountId: string }) => {
      dispatch(
        api.util.invalidateTags([{ type: 'WaCommunities', id: p.accountId }]),
      );
    };
    const onMessage = (p: {
      accountId: string;
      message: WaMessage;
      chat?: WaChat;
    }) => {
      // Notification locale (onglet en arrière-plan). La discussion jointe par
      // le serveur fait foi (nom, sourdine) : la liste en cache n'existe que
      // pour le compte affiché. Repli sur le cache pour les autres événements.
      const chat =
        p.chat ??
        chatsApi.endpoints.getChats
          .select(p.accountId)(store.getState())
          .data?.find((c) => c.jid === p.message.chatJid);
      notifyIncoming(p.message, {
        chat,
        onOpen: () => {
          dispatch(setViewMode('account'));
          dispatch(setActiveAccount(p.accountId));
          dispatch(selectChat(p.message.chatJid));
        },
      });
      dispatch(upsertMessage(p.accountId, p.message.chatJid, p.message));
      // Le message est arrivé : « écrit… » s'éteint sans attendre la pause.
      if (!p.message.fromMe) {
        dispatch(
          setPresence({
            accountId: p.accountId,
            jid: p.message.chatJid,
            kind: p.message.chatJid.endsWith('@g.us')
              ? PresenceKind.PAUSED
              : PresenceKind.AVAILABLE,
            at: Date.now(),
          }),
        );
      }
      dispatch(patchChatLastMessage(p.accountId, p.message));
      // Vue fusionnée: patche la timeline de la personne (no-op si non observée).
      dispatch(upsertPersonMessage(p.message));
      // Reflète le nouveau dernier message / unread dans la liste du compte…
      dispatch(
        api.util.invalidateTags([{ type: 'WaChats', id: p.accountId }]),
      );
      // …et dans la boîte fusionnée (aperçu / ordre / non-lus agrégés).
      dispatch(api.util.invalidateTags([{ type: 'People', id: 'LIST' }]));
    };
    const onMessageStatus = (p: {
      accountId: string;
      id: string;
      chatJid: string;
      status: WaMessageStatus;
    }) => {
      dispatch(updateMessageStatus(p.accountId, p.chatJid, p.id, p.status));
      dispatch(updateChatLastStatus(p.accountId, p.chatJid, p.id, p.status));
      dispatch(
        updatePersonMessageStatus(p.accountId, p.chatJid, p.id, p.status),
      );
    };
    const onMessageDeleted = (p: {
      accountId: string;
      id: string;
      chatJid: string;
    }) => {
      dispatch(removeMessage(p.accountId, p.chatJid, p.id));
      dispatch(removePersonMessage(p.accountId, p.chatJid, p.id));
      dispatch(
        api.util.invalidateTags([
          { type: 'People', id: 'LIST' },
          // Le dernier message (aperçu, coches) a pu changer.
          { type: 'WaChats', id: p.accountId },
        ]),
      );
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
      dispatch(
        updatePersonReactions(
          p.accountId,
          p.chatJid,
          p.messageId,
          p.reactions,
        ),
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
        api.util.invalidateTags([
          { type: 'WaChats', id: p.accountId },
          // Boîte fusionnée: le sync peut changer aperçus / personnes.
          { type: 'People', id: 'LIST' },
          // Communautés : le sync (backfill) peut les (re)peupler.
          { type: 'WaCommunities', id: p.accountId },
        ]),
      );
      if (p.chatJid) {
        dispatch(
          api.util.invalidateTags([
            { type: 'WaMessages', id: cacheKey(p.accountId, p.chatJid) },
            // Timeline fusionnée de cette personne (refetch si observée).
            { type: 'PersonTimeline', id: personKey(p.chatJid) },
          ]),
        );
      }
    };

    socket.on('wa:accounts', onAccounts);
    socket.on('wa:connection', onConnection);
    socket.on('wa:chats', onChats);
    socket.on('wa:chat-upsert', onChatUpsert);
    socket.on('wa:community', onCommunity);
    socket.on('wa:message', onMessage);
    socket.on('wa:message-status', onMessageStatus);
    socket.on('wa:message-deleted', onMessageDeleted);
    socket.on('wa:reaction', onReaction);
    socket.on('wa:presence', onPresence);
    socket.on('wa:history-synced', onHistorySynced);

    // Onglet utilisé ou non (cf. setClientActive). Recalculé sur les
    // changements de visibilité / focus, à la reprise d'activité, toutes les
    // 30 s (inactivité) et à chaque (re)connexion du socket.
    let active = false;
    let lastInput = Date.now();
    const computeActive = () =>
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      Date.now() - lastInput < IDLE_MS;
    const syncActive = (force = false) => {
      const a = computeActive();
      if (a !== active || force) {
        active = a;
        setClientActive(a);
      }
    };
    const onFocusChange = () => syncActive();
    const onConnect = () => syncActive(true);
    const onInput = () => {
      lastInput = Date.now();
      if (!active) syncActive();
    };
    const inputEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const ev of inputEvents) {
      window.addEventListener(ev, onInput, { passive: true });
    }
    document.addEventListener('visibilitychange', onFocusChange);
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    socket.on('connect', onConnect);
    const idleTimer = window.setInterval(() => syncActive(), 30_000);
    syncActive(true);

    return () => {
      for (const ev of inputEvents) window.removeEventListener(ev, onInput);
      document.removeEventListener('visibilitychange', onFocusChange);
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      socket.off('connect', onConnect);
      window.clearInterval(idleTimer);
      if (active) setClientActive(false);
      socket.off('wa:accounts', onAccounts);
      socket.off('wa:connection', onConnection);
      socket.off('wa:chats', onChats);
      socket.off('wa:chat-upsert', onChatUpsert);
      socket.off('wa:community', onCommunity);
      socket.off('wa:message', onMessage);
      socket.off('wa:message-status', onMessageStatus);
      socket.off('wa:message-deleted', onMessageDeleted);
      socket.off('wa:reaction', onReaction);
      socket.off('wa:presence', onPresence);
      socket.off('wa:history-synced', onHistorySynced);
    };
  }, [token, dispatch]);
}
