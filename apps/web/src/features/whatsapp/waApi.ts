import { api } from '../../app/api';
import type { WaConnection } from '@app/shared-types';
import { setConnection } from './waSlice';

export const waApi = api.injectEndpoints({
  endpoints: (builder) => ({
    // État courant de la connexion WhatsApp (Baileys). Initialise le slice wa
    // au montage de l'app authentifiée; le live se fait ensuite via socket.
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
  }),
});

export const { useGetStatusQuery } = waApi;
