import type { WaMessage } from '../dto/whatsapp';

// Événements émis par le client web vers le backend.
export interface ClientToServerEvents {
  // Envoi d'un message texte vers une discussion WhatsApp. accountId optionnel
  // (défaut serveur 'default') -> rétro-compatible avec le front actuel.
  'wa:send-text': (
    input: {
      accountId?: string;
      chatJid: string;
      text: string;
      clientId: string;
      quotedId?: string;
    },
    ack: (res: { ok: boolean; message?: WaMessage; error?: string }) => void,
  ) => void;

  // Marque une discussion comme lue (envoie les accusés de lecture côté WhatsApp).
  'wa:mark-read': (input: { accountId?: string; chatJid: string }) => void;

  // Signale qu'on est en train d'écrire (composing) ou arrêt (paused).
  'wa:typing': (input: { accountId?: string; chatJid: string; typing: boolean }) => void;

  // S'abonne à la présence d'un contact (online / typing).
  'wa:subscribe-presence': (input: { accountId?: string; jid: string }) => void;

  // Délie la session WhatsApp (logout) -> nécessitera un nouveau scan.
  'wa:logout': (
    input: { accountId?: string },
    ack: (res: { ok: boolean }) => void,
  ) => void;

  // Archive / désarchive une discussion.
  'wa:archive': (input: { accountId?: string; chatJid: string; archived: boolean }) => void;

  // Coupe / réactive les notifications d'une discussion (mute).
  'wa:mute': (input: { accountId?: string; chatJid: string; muted: boolean }) => void;

  // Bloque / débloque un contact (1:1).
  'wa:block': (input: { accountId?: string; chatJid: string; blocked: boolean }) => void;
}
