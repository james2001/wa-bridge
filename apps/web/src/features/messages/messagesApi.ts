import { api } from '../../app/api';
import type {
  WaMessage,
  WaMessageInfoResponse,
  WaMessagesPage,
  WaMessageStatus,
  WaReaction,
} from '@app/shared-types';

// Argument de getMessages. `before` (epoch ms) sert à la pagination de
// l'historique: il est volontairement EXCLU de la clé de cache (cf.
// serializeQueryArgs) afin que toutes les pages d'une même discussion
// partagent une seule entrée de cache, identifiée par (accountId, jid).
export interface GetMessagesArg {
  accountId: string;
  jid: string;
  before?: number;
}

// Clé de cache d'une discussion: (accountId, jid). Un même JID peut exister sur
// plusieurs comptes (ex: ton propre numéro) -> le compte fait partie de la clé.
// Exportée pour que le pont socket cible le MÊME id de tag lors des invalidations.
export const cacheKey = (accountId: string, jid: string) =>
  `${accountId} ${jid}`;

export const messagesApi = api.injectEndpoints({
  endpoints: (builder) => ({
    // Cache des messages par (accountId, jid) (un cache distinct par discussion).
    getMessages: builder.query<WaMessagesPage, GetMessagesArg>({
      query: ({ accountId, jid, before }) => ({
        url: `/wa/chats/${encodeURIComponent(jid)}/messages`,
        params:
          before != null
            ? { accountId, limit: 50, before }
            : { accountId, limit: 50 },
      }),
      // Clé de cache = (accountId, jid): les pages plus anciennes fusionnent
      // dans la même entrée que les messages récents et live (socket).
      serializeQueryArgs: ({ queryArgs }) =>
        cacheKey(queryArgs.accountId, queryArgs.jid),
      // Fusionne la page entrante avec le cache existant (préfixe l'historique
      // plus ancien), en dédupliquant par id et en triant chronologiquement.
      merge: (currentCache, incoming) => {
        const byId = new Map<string, WaMessage>();
        for (const m of currentCache.messages) byId.set(m.id, m);
        // Les messages de la page entrante priment (version serveur à jour).
        for (const m of incoming.messages) byId.set(m.id, m);
        currentCache.messages = Array.from(byId.values()).sort(
          (a, b) => a.timestamp - b.timestamp,
        );
        // hasMore / nextBefore reflètent la page la plus ancienne chargée.
        currentCache.hasMore = incoming.hasMore;
        currentCache.nextBefore = incoming.nextBefore;
      },
      // Re-fetch lorsqu'on demande une page différente (changement de `before`).
      forceRefetch: ({ currentArg, previousArg }) =>
        currentArg?.before !== previousArg?.before,
      providesTags: (_result, _error, arg) => [
        { type: 'WaMessages', id: cacheKey(arg.accountId, arg.jid) },
      ],
    }),
    // Accusés de réception d'un message SORTANT (panneau « Infos du message »).
    // Le backend ne renvoie de receipts que pour un message `fromMe`.
    getMessageInfo: builder.query<
      WaMessageInfoResponse,
      { accountId: string; jid: string; id: string }
    >({
      query: ({ accountId, jid, id }) => ({
        url: `/wa/chats/${encodeURIComponent(jid)}/messages/${encodeURIComponent(id)}/info`,
        params: { accountId },
      }),
    }),
  }),
});

export const { useGetMessagesQuery, useGetMessageInfoQuery } = messagesApi;

// Toutes les mises à jour de cache ci-dessous ciblent l'entrée (accountId, jid),
// qui se résout (via serializeQueryArgs) vers la MÊME clé de cache que la query
// paginée — quelle que soit la valeur de `before` utilisée pour charger.

// Insère ou remplace un message dans le cache de sa discussion.
// Le matching se fait sur l'id WhatsApp OU le clientId (réconciliation de
// l'écho optimistic). Utilisé par le socket ('wa:message') et le Composer.
export function upsertMessage(
  accountId: string,
  jid: string,
  message: WaMessage,
) {
  return messagesApi.util.updateQueryData(
    'getMessages',
    { accountId, jid },
    (draft) => {
      const idx = draft.messages.findIndex(
        (m) =>
          m.id === message.id ||
          (message.clientId != null &&
            m.clientId != null &&
            m.clientId === message.clientId),
      );
      if (idx >= 0) draft.messages[idx] = message;
      else draft.messages.push(message);
      draft.messages.sort((a, b) => a.timestamp - b.timestamp);
    },
  );
}

// Met à jour le statut (checkmarks) d'un message ('wa:message-status').
export function updateMessageStatus(
  accountId: string,
  jid: string,
  id: string,
  status: WaMessageStatus,
) {
  return messagesApi.util.updateQueryData(
    'getMessages',
    { accountId, jid },
    (draft) => {
      const m = draft.messages.find((mm) => mm.id === id);
      if (m) m.status = status;
    },
  );
}

// Remplace les réactions d'un message ('wa:reaction').
export function updateReactions(
  accountId: string,
  jid: string,
  messageId: string,
  reactions: WaReaction[],
) {
  return messagesApi.util.updateQueryData(
    'getMessages',
    { accountId, jid },
    (draft) => {
      const m = draft.messages.find((mm) => mm.id === messageId);
      if (m) m.reactions = reactions;
    },
  );
}

// Retire un message révoqué/supprimé ('wa:message-deleted').
export function removeMessage(accountId: string, jid: string, id: string) {
  return messagesApi.util.updateQueryData(
    'getMessages',
    { accountId, jid },
    (draft) => {
      const idx = draft.messages.findIndex((m) => m.id === id);
      if (idx >= 0) draft.messages.splice(idx, 1);
    },
  );
}
