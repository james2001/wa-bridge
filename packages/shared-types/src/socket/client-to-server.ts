import type { WaMessage } from '../dto/whatsapp';

// Événements émis par le client web vers le backend.
export interface ClientToServerEvents {
  // Envoi d'un message texte vers une discussion WhatsApp.
  'wa:send-text': (
    input: { chatJid: string; text: string; clientId: string; quotedId?: string },
    ack: (res: { ok: boolean; message?: WaMessage; error?: string }) => void,
  ) => void;

  // Marque une discussion comme lue (envoie les accusés de lecture côté WhatsApp).
  'wa:mark-read': (input: { chatJid: string }) => void;

  // Signale qu'on est en train d'écrire (composing) ou arrêt (paused).
  'wa:typing': (input: { chatJid: string; typing: boolean }) => void;

  // S'abonne à la présence d'un contact (online / typing).
  'wa:subscribe-presence': (input: { jid: string }) => void;

  // Délie la session WhatsApp (logout) -> nécessitera un nouveau scan.
  'wa:logout': (ack: (res: { ok: boolean }) => void) => void;
}
