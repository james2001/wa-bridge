import { api } from '../../app/api';
import type {
  WaChat,
  WaChatsResponse,
  WaChatMediaResponse,
  WaMediaItem,
  WaContactAbout,
} from '@app/shared-types';

export const chatsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getChats: builder.query<WaChat[], void>({
      query: () => ({ url: '/wa/chats' }),
      transformResponse: (response: WaChatsResponse) => response.chats,
      providesTags: ['WaChats'],
    }),
    // Galerie « Médias, liens et documents » d'une discussion (récents d'abord).
    // Clé de cache = jid ; partagée entre le panneau d'infos et la galerie.
    getChatMedia: builder.query<WaMediaItem[], string>({
      query: (jid) => ({ url: `/wa/chats/${encodeURIComponent(jid)}/media` }),
      transformResponse: (response: WaChatMediaResponse) => response.items,
    }),
    // Bio « À propos » d'un contact 1:1 (clé de cache = jid).
    getContactAbout: builder.query<WaContactAbout, string>({
      query: (jid) => ({ url: `/wa/contacts/${encodeURIComponent(jid)}/about` }),
    }),
  }),
});

export const { useGetChatsQuery, useGetChatMediaQuery, useGetContactAboutQuery } =
  chatsApi;

// Remplace tout le cache de la liste (sync initiale 'wa:chats').
export function setChats(chats: WaChat[]) {
  return chatsApi.util.upsertQueryData('getChats', undefined, chats);
}

// Insère ou met à jour une discussion ('wa:chat-upsert' / nouveau message).
export function upsertChat(chat: WaChat) {
  return chatsApi.util.updateQueryData('getChats', undefined, (draft) => {
    const idx = draft.findIndex((c) => c.jid === chat.jid);
    if (idx >= 0) draft[idx] = chat;
    else draft.push(chat);
    draft.sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
  });
}
