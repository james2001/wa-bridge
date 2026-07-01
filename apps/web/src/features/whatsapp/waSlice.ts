import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { ConnectionState, DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import type {
  WaAccount,
  WaAccountsResponse,
  WaConnection,
  WaPresence,
} from '@app/shared-types';
import type { RootState } from '../../app/store';

interface WaState {
  // Liste des comptes du pont (multi-compte), ordonnée côté serveur.
  accounts: WaAccount[];
  defaultAccountId: string;
  // État de connexion par compte (clé = accountId).
  connections: Record<string, WaConnection>;
  // Présence par JID (online / en train d'écrire…). Scopée au compte actif:
  // les JIDs sont uniques par compte, on préfixe donc la clé par accountId.
  presences: Record<string, WaPresence>;
}

// Connexion placeholder avant le premier 'wa:connection' d'un compte.
// Mémoïsée par accountId: `selectConnection` doit renvoyer une référence STABLE
// pour un compte sans connexion (sinon useSelector re-render en boucle).
const placeholderCache = new Map<string, WaConnection>();
function placeholderConnection(accountId: string): WaConnection {
  let p = placeholderCache.get(accountId);
  if (!p) {
    p = {
      accountId,
      state: ConnectionState.CONNECTING,
      qr: null,
      me: null,
    };
    placeholderCache.set(accountId, p);
  }
  return p;
}

const initialState: WaState = {
  accounts: [],
  defaultAccountId: DEFAULT_ACCOUNT_ID,
  connections: {
    [DEFAULT_ACCOUNT_ID]: placeholderConnection(DEFAULT_ACCOUNT_ID),
  },
  presences: {},
};

// Clé de présence: (accountId, jid) — évite les collisions entre comptes.
const presenceKey = (accountId: string, jid: string) => `${accountId} ${jid}`;

const waSlice = createSlice({
  name: 'wa',
  initialState,
  reducers: {
    setAccounts(state, action: PayloadAction<WaAccountsResponse>) {
      state.accounts = action.payload.accounts;
      state.defaultAccountId = action.payload.defaultAccountId;
    },
    setConnection(state, action: PayloadAction<WaConnection>) {
      state.connections[action.payload.accountId] = action.payload;
    },
    setPresence(state, action: PayloadAction<WaPresence>) {
      const key = presenceKey(action.payload.accountId, action.payload.jid);
      state.presences[key] = action.payload;
    },
  },
});

export const { setAccounts, setConnection, setPresence } = waSlice.actions;

export default waSlice.reducer;

export const selectAccounts = (state: RootState): WaAccount[] =>
  state.wa.accounts;

export const selectDefaultAccountId = (state: RootState): string =>
  state.wa.defaultAccountId;

// Map complète des connexions par compte (statut live via 'wa:connection').
export const selectConnections = (
  state: RootState,
): Record<string, WaConnection> => state.wa.connections;

// Connexion d'un compte donné (placeholder stable tant qu'aucun 'wa:connection').
export const selectConnection =
  (accountId: string) =>
  (state: RootState): WaConnection =>
    state.wa.connections[accountId] ?? placeholderConnection(accountId);

export const selectPresence =
  (accountId: string, jid: string) =>
  (state: RootState): WaPresence | undefined =>
    state.wa.presences[presenceKey(accountId, jid)];
