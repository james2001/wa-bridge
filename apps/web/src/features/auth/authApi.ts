import { api } from '../../app/api';
import type {
  AuthSession,
  LoginRequest,
  RefreshResponse,
} from '@app/shared-types';
import { logout as logoutAction, setAccessToken, setCredentials } from './authSlice';

export const authApi = api.injectEndpoints({
  endpoints: (builder) => ({
    // Connexion par mot de passe d'app. Pose le cookie refresh HttpOnly et
    // renvoie l'accessToken (stocké en mémoire via setCredentials).
    login: builder.mutation<AuthSession, LoginRequest>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(setCredentials(data));
        } catch {
          /* l'erreur est gérée par le composant via le hook mutation */
        }
      },
    }),

    // Au démarrage: tente de restaurer la session via le cookie refresh.
    refresh: builder.mutation<RefreshResponse, void>({
      query: () => ({ url: '/auth/refresh', method: 'POST' }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(setAccessToken(data.accessToken));
        } catch {
          dispatch(logoutAction());
        }
      },
    }),

    logout: builder.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } catch {
          /* on déconnecte localement quoi qu'il arrive */
        }
        dispatch(logoutAction());
      },
    }),
  }),
});

export const { useLoginMutation, useRefreshMutation, useLogoutMutation } =
  authApi;
