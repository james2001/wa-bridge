import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';

// État d'UI local: la discussion sélectionnée. On garde le JID en mémoire
// plutôt que dans l'URL car les JIDs contiennent '@' (routing fragile).
// `infoPanelOpen` pilote le volet « Infos » à droite de la conversation.
interface UiState {
  selectedChatJid: string | null;
  infoPanelOpen: boolean;
}

const initialState: UiState = {
  selectedChatJid: null,
  infoPanelOpen: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    selectChat(state, action: PayloadAction<string | null>) {
      state.selectedChatJid = action.payload;
      // On referme le panneau d'infos en changeant de discussion.
      state.infoPanelOpen = false;
    },
    openInfoPanel(state) {
      state.infoPanelOpen = true;
    },
    closeInfoPanel(state) {
      state.infoPanelOpen = false;
    },
    toggleInfoPanel(state) {
      state.infoPanelOpen = !state.infoPanelOpen;
    },
  },
});

export const { selectChat, openInfoPanel, closeInfoPanel, toggleInfoPanel } =
  uiSlice.actions;

export default uiSlice.reducer;

export const selectSelectedChatJid = (state: RootState): string | null =>
  state.ui.selectedChatJid;
export const selectInfoPanelOpen = (state: RootState): boolean =>
  state.ui.infoPanelOpen;
