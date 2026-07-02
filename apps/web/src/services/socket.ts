import { io, Socket } from 'socket.io-client';
import { DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  WaAccount,
  WaMessage,
} from '@app/shared-types';

// Client socket.io fortement typé sur le contrat partagé.
export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

// (Re)connecte le socket avec le token courant. Idempotent: réutilise
// l'instance existante en mettant à jour l'auth.
export function connectSocket(token: string): AppSocket {
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) socket.connect();
    return socket;
  }

  // URL vide => connexion same-origin (le socket suit l'hôte:port de la page,
  // ce qui rend le déploiement indépendant du port et compatible reverse proxy).
  const url = import.meta.env.VITE_SOCKET_URL || undefined;
  socket = io(url, {
    transports: ['websocket'],
    auth: { token },
    withCredentials: true,
    autoConnect: true,
  });

  return socket;
}

export function getSocket(): AppSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export interface SendTextInput {
  // Compte émetteur (défaut 'default' si omis, rétro-compat serveur).
  accountId?: string;
  chatJid: string;
  text: string;
  clientId: string;
  quotedId?: string;
}

export interface SendTextAck {
  ok: boolean;
  message?: WaMessage;
  error?: string;
}

// Envoie un message texte et résout sur l'ACK serveur.
export function sendText(input: SendTextInput): Promise<SendTextAck> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(15_000).emit(
      'wa:send-text',
      // accountId par défaut 'default' ; un appelant peut le surcharger.
      { accountId: DEFAULT_ACCOUNT_ID, ...input },
      (err: Error | null, ack: SendTextAck) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// Marque une discussion comme lue (accusés de lecture côté WhatsApp).
export function markRead(accountId: string, chatJid: string): void {
  socket?.emit('wa:mark-read', { accountId, chatJid });
}

// Signale (ou arrête) l'état "en train d'écrire".
export function setTyping(
  accountId: string,
  chatJid: string,
  typing: boolean,
): void {
  socket?.emit('wa:typing', { accountId, chatJid, typing });
}

// S'abonne à la présence d'un contact.
export function subscribePresence(accountId: string, jid: string): void {
  socket?.emit('wa:subscribe-presence', { accountId, jid });
}

// Archive / désarchive une discussion.
export function archiveChat(
  accountId: string,
  chatJid: string,
  archived: boolean,
): void {
  socket?.emit('wa:archive', { accountId, chatJid, archived });
}

// Coupe / réactive les notifications d'une discussion (mute).
export function muteChat(
  accountId: string,
  chatJid: string,
  muted: boolean,
): void {
  socket?.emit('wa:mute', { accountId, chatJid, muted });
}

// Bloque / débloque un contact (le backend renvoie un 'wa:chat-upsert' à jour).
export function blockChat(
  accountId: string,
  chatJid: string,
  blocked: boolean,
): void {
  socket?.emit('wa:block', { accountId, chatJid, blocked });
}

// Délie la session WhatsApp d'un compte (un nouveau scan QR sera nécessaire).
export function waLogout(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(10_000).emit(
      'wa:logout',
      { accountId },
      (err: Error | null, ack: { ok: boolean }) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// --- Gestion des comptes (multi-compte) ---

// Crée un compte et lance sa connexion (un QR arrivera via 'wa:connection').
export function createAccount(
  label: string,
  color?: string,
): Promise<{ ok: boolean; account?: WaAccount; error?: string }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(15_000).emit(
      'wa:account-create',
      { label, color },
      (
        err: Error | null,
        ack: { ok: boolean; account?: WaAccount; error?: string },
      ) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// (Re)lance la connexion d'un compte existant (régénérer un QR).
export function connectAccount(accountId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(10_000).emit(
      'wa:account-connect',
      { accountId },
      (err: Error | null, ack: { ok: boolean }) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// Renomme / recolore un compte.
export function renameAccount(
  accountId: string,
  label?: string,
  color?: string,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(10_000).emit(
      'wa:account-rename',
      { accountId, label, color },
      (err: Error | null, ack: { ok: boolean }) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// Supprime un compte (déliaison + purge). Interdit sur 'default' côté serveur.
export function deleteAccount(
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(15_000).emit(
      'wa:account-delete',
      { accountId },
      (err: Error | null, ack: { ok: boolean; error?: string }) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}
