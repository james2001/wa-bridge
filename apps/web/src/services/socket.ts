import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
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
      input,
      (err: Error | null, ack: SendTextAck) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}

// Marque une discussion comme lue (accusés de lecture côté WhatsApp).
export function markRead(chatJid: string): void {
  socket?.emit('wa:mark-read', { chatJid });
}

// Signale (ou arrête) l'état "en train d'écrire".
export function setTyping(chatJid: string, typing: boolean): void {
  socket?.emit('wa:typing', { chatJid, typing });
}

// S'abonne à la présence d'un contact.
export function subscribePresence(jid: string): void {
  socket?.emit('wa:subscribe-presence', { jid });
}

// Délie la session WhatsApp (un nouveau scan QR sera nécessaire).
export function waLogout(): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('Socket non connecté'));
      return;
    }
    s.timeout(10_000).emit(
      'wa:logout',
      (err: Error | null, ack: { ok: boolean }) => {
        if (err) reject(err);
        else resolve(ack);
      },
    );
  });
}
