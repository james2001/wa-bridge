import { api } from '../../app/api';
import type { WaAccountsResponse, WaConnection } from '@app/shared-types';
import { setAccounts, setConnection } from './waSlice';

export const waApi = api.injectEndpoints({
  endpoints: (builder) => ({
    // État courant de la connexion WhatsApp (Baileys) du compte par défaut.
    // Initialise le slice wa au montage; le live se fait ensuite via socket.
    getStatus: builder.query<WaConnection, void>({
      query: () => ({ url: '/wa/status' }),
      providesTags: ['WaStatus'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(setConnection(data));
        } catch {
          /* le baseQuery gère le refresh/logout sur 401 */
        }
      },
    }),
    // Liste des comptes du pont (multi-compte). Le live (ajout/suppression)
    // arrive ensuite via l'événement socket 'wa:accounts'.
    getAccounts: builder.query<WaAccountsResponse, void>({
      query: () => ({ url: '/wa/accounts' }),
      providesTags: ['WaAccounts'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(setAccounts(data));
        } catch {
          /* ignore: le socket resynchronisera */
        }
      },
    }),
  }),
});

export const { useGetStatusQuery, useGetAccountsQuery } = waApi;
