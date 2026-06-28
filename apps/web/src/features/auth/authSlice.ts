import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { AuthSession } from '@app/shared-types';
import type { RootState } from '../../app/store';

interface AuthState {
  // L'accessToken vit en mémoire uniquement (jamais localStorage).
  // La persistance est assurée par le cookie refresh HttpOnly côté serveur.
  accessToken: string | null;
}

const initialState: AuthState = {
  accessToken: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials(state, action: PayloadAction<AuthSession>) {
      state.accessToken = action.payload.accessToken;
    },
    setAccessToken(state, action: PayloadAction<string>) {
      state.accessToken = action.payload;
    },
    logout(state) {
      state.accessToken = null;
    },
  },
});

export const { setCredentials, setAccessToken, logout } = authSlice.actions;

export default authSlice.reducer;

export const selectAccessToken = (state: RootState): string | null =>
  state.auth.accessToken;
export const selectIsAuthenticated = (state: RootState): boolean =>
  Boolean(state.auth.accessToken);
