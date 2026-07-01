import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import type { RootState } from '../../app/store';
import { logout } from '../auth/authSlice';

// État d'UI local: la discussion sélectionnée. On garde le JID en mémoire
// plutôt que dans l'URL car les JIDs contiennent '@' (routing fragile).
// `infoPanelOpen` pilote le volet « Infos » à droite de la conversation.
// `activeAccountId` = compte WhatsApp actuellement affiché (sélecteur multi-compte).
interface UiState {
  selectedChatJid: string | null;
  infoPanelOpen: boolean;
  activeAccountId: string;
}

const initialState: UiState = {
  selectedChatJid: null,
  infoPanelOpen: false,
  activeAccountId: DEFAULT_ACCOUNT_ID,
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
    // Change de compte affiché: on repart d'une conversation vide (les JIDs
    // d'un compte n'ont pas de sens dans un autre).
    setActiveAccount(state, action: PayloadAction<string>) {
      if (state.activeAccountId === action.payload) return;
      state.activeAccountId = action.payload;
      state.selectedChatJid = null;
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
  extraReducers: (builder) => {
    // À la déconnexion, on réinitialise l'UI (discussion + volet d'infos).
    builder.addCase(logout, () => initialState);
  },
});

export const {
  selectChat,
  setActiveAccount,
  openInfoPanel,
  closeInfoPanel,
  toggleInfoPanel,
} = uiSlice.actions;

export default uiSlice.reducer;

export const selectSelectedChatJid = (state: RootState): string | null =>
  state.ui.selectedChatJid;
export const selectInfoPanelOpen = (state: RootState): boolean =>
  state.ui.infoPanelOpen;
export const selectActiveAccountId = (state: RootState): string =>
  state.ui.activeAccountId;
