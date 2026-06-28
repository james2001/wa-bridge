import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { ConnectionState } from '@app/shared-types';
import type { WaConnection, WaPresence } from '@app/shared-types';
import type { RootState } from '../../app/store';

interface WaState {
  connection: WaConnection;
  // Présence par JID (online / en train d'écrire…).
  presences: Record<string, WaPresence>;
}

const initialState: WaState = {
  connection: { state: ConnectionState.CONNECTING, qr: null, me: null },
  presences: {},
};

const waSlice = createSlice({
  name: 'wa',
  initialState,
  reducers: {
    setConnection(state, action: PayloadAction<WaConnection>) {
      state.connection = action.payload;
    },
    setPresence(state, action: PayloadAction<WaPresence>) {
      state.presences[action.payload.jid] = action.payload;
    },
  },
});

export const { setConnection, setPresence } = waSlice.actions;

export default waSlice.reducer;

export const selectConnection = (state: RootState): WaConnection =>
  state.wa.connection;

export const selectPresence =
  (jid: string) =>
  (state: RootState): WaPresence | undefined =>
    state.wa.presences[jid];
