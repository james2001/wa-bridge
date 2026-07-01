import { api } from '../../app/api';
import type {
  WaChat,
  WaChatsResponse,
  WaChatMediaResponse,
  WaMediaItem,
  WaContactAbout,
} from '@app/shared-types';

// Argument scopé au compte pour les ressources liées à une discussion.
export interface AccountJidArg {
  accountId: string;
  jid: string;
}

export const chatsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    // Discussions d'un compte (clé de cache = accountId). Chaque compte a sa
    // propre entrée de cache, alimentée par le socket via `setChats`/`upsertChat`.
    getChats: builder.query<WaChat[], string>({
      query: (accountId) => ({ url: '/wa/chats', params: { accountId } }),
      transformResponse: (response: WaChatsResponse) => response.chats,
      providesTags: (_r, _e, accountId) => [
        { type: 'WaChats' as const, id: accountId },
      ],
    }),
    // Galerie « Médias, liens et documents » d'une discussion (récents d'abord).
    // Clé de cache = (accountId, jid) ; partagée entre le panneau d'infos et la
    // galerie.
    getChatMedia: builder.query<WaMediaItem[], AccountJidArg>({
      query: ({ accountId, jid }) => ({
        url: `/wa/chats/${encodeURIComponent(jid)}/media`,
        params: { accountId },
      }),
      transformResponse: (response: WaChatMediaResponse) => response.items,
    }),
    // Bio « À propos » d'un contact 1:1 (clé de cache = (accountId, jid)).
    getContactAbout: builder.query<WaContactAbout, AccountJidArg>({
      query: ({ accountId, jid }) => ({
        url: `/wa/contacts/${encodeURIComponent(jid)}/about`,
        params: { accountId },
      }),
    }),
  }),
});

export const { useGetChatsQuery, useGetChatMediaQuery, useGetContactAboutQuery } =
  chatsApi;

// Remplace tout le cache de la liste d'un compte (sync initiale 'wa:chats').
export function setChats(accountId: string, chats: WaChat[]) {
  return chatsApi.util.upsertQueryData('getChats', accountId, chats);
}

// Insère ou met à jour une discussion ('wa:chat-upsert' / nouveau message).
export function upsertChat(accountId: string, chat: WaChat) {
  return chatsApi.util.updateQueryData('getChats', accountId, (draft) => {
    const idx = draft.findIndex((c) => c.jid === chat.jid);
    if (idx >= 0) draft[idx] = chat;
    else draft.push(chat);
    draft.sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
  });
}
