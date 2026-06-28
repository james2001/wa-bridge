import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';

// État d'UI local: la discussion sélectionnée. On garde le JID en mémoire
// plutôt que dans l'URL car les JIDs contiennent '@' (routing fragile).
interface UiState {
  selectedChatJid: string | null;
}

const initialState: UiState = {
  selectedChatJid: null,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    selectChat(state, action: PayloadAction<string | null>) {
      state.selectedChatJid = action.payload;
    },
  },
});

export const { selectChat } = uiSlice.actions;

export default uiSlice.reducer;

export const selectSelectedChatJid = (state: RootState): string | null =>
  state.ui.selectedChatJid;
