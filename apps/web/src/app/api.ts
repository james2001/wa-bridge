import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';
import type { RefreshResponse } from '@app/shared-types';
import type { RootState } from './store';
import { logout, setAccessToken } from '../features/auth/authSlice';

const rawBaseQuery = fetchBaseQuery({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
  credentials: 'include',
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.accessToken;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  },
});

// Sur 401: tente un refresh (cookie HttpOnly), met à jour l'accessToken en
// mémoire, puis rejoue la requête initiale. En cas d'échec => logout.
let refreshPromise: Promise<string | null> | null = null;

const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, apiCtx, extraOptions) => {
  let result = await rawBaseQuery(args, apiCtx, extraOptions);

  if (result.error && result.error.status === 401) {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const refresh = await rawBaseQuery(
          { url: '/auth/refresh', method: 'POST' },
          apiCtx,
          extraOptions,
        );
        if (refresh.data) {
          const { accessToken } = refresh.data as RefreshResponse;
          apiCtx.dispatch(setAccessToken(accessToken));
          return accessToken;
        }
        apiCtx.dispatch(logout());
        return null;
      })().finally(() => {
        refreshPromise = null;
      });
    }

    const token = await refreshPromise;
    if (token) {
      result = await rawBaseQuery(args, apiCtx, extraOptions);
    }
  }

  return result;
};

// API centrale RTK Query. Les features injectent leurs endpoints via
// `api.injectEndpoints` (code-splitting du contrat).
export const api = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: [
    'WaChats',
    'WaMessages',
    'WaStatus',
    'WaAccounts',
    // Vue fusionnée par personne (Phase 3).
    'People',
    'PersonTimeline',
  ],
  endpoints: () => ({}),
});
