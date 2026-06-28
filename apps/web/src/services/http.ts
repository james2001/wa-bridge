import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import type { RefreshResponse } from '@app/shared-types';
import { store } from '../app/store';
import {
  logout,
  selectAccessToken,
  setAccessToken,
} from '../features/auth/authSlice';

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

// Instance axios pour les appels hors RTK Query (ex: tokens LiveKit).
export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,
});

http.interceptors.request.use((config) => {
  const token = selectAccessToken(store.getState());
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await axios.post<RefreshResponse>('/auth/refresh', null, {
      baseURL: import.meta.env.VITE_API_BASE_URL,
      withCredentials: true,
    });
    store.dispatch(setAccessToken(res.data.accessToken));
    return res.data.accessToken;
  } catch {
    store.dispatch(logout());
    return null;
  }
}

http.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) {
      return Promise.reject(error);
    }
    const original = error.config as RetriableConfig;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
      }
      const token = await refreshPromise;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return http(original);
      }
    }
    return Promise.reject(error);
  },
);
