import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import type { RootState } from '../../app/store';
import { logout } from '../auth/authSlice';

// Mode d'affichage de la barre latérale :
// - 'account' : discussions du compte actif (mono-compte, comportement historique)
// - 'merged'  : boîte de réception fusionnée, une entrée par personne (multi-compte)
export type ViewMode = 'account' | 'merged';

// État d'UI local: la discussion sélectionnée. On garde le JID en mémoire
// plutôt que dans l'URL car les JIDs contiennent '@' (routing fragile).
// `infoPanelOpen` pilote le volet « Infos » à droite de la conversation.
// `activeAccountId` = compte WhatsApp actuellement affiché (sélecteur multi-compte).
// `viewMode` / `selectedPersonId` : vue fusionnée par personne (Phase 3).
interface UiState {
  selectedChatJid: string | null;
  infoPanelOpen: boolean;
  activeAccountId: string;
  viewMode: ViewMode;
  // Personne sélectionnée en mode 'merged' (JID pn transverse aux comptes).
  selectedPersonId: string | null;
}

const initialState: UiState = {
  selectedChatJid: null,
  infoPanelOpen: false,
  activeAccountId: DEFAULT_ACCOUNT_ID,
  viewMode: 'account',
  selectedPersonId: null,
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
    // Bascule Comptes <-> Fusionné. On repart d'une sélection vide (les JIDs
    // d'un compte et les personnes fusionnées ne partagent pas le même contexte).
    setViewMode(state, action: PayloadAction<ViewMode>) {
      if (state.viewMode === action.payload) return;
      state.viewMode = action.payload;
      state.selectedChatJid = null;
      state.selectedPersonId = null;
      state.infoPanelOpen = false;
    },
    // Sélectionne une personne en mode fusionné (miroir de selectChat).
    selectPerson(state, action: PayloadAction<string | null>) {
      state.selectedPersonId = action.payload;
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
  setViewMode,
  selectPerson,
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
export const selectViewMode = (state: RootState): ViewMode =>
  state.ui.viewMode;
export const selectSelectedPersonId = (state: RootState): string | null =>
  state.ui.selectedPersonId;
