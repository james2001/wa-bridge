import type { WaAccount, WaMessage } from '../dto/whatsapp';

// Événements émis par le client web vers le backend.
export interface ClientToServerEvents {
  // Crée un nouveau compte (multi-compte) et lance sa connexion -> un QR sera
  // émis via 'wa:connection' pour l'accountId renvoyé dans l'ACK.
  'wa:account-create': (
    input: { label: string; color?: string },
    ack: (res: { ok: boolean; account?: WaAccount; error?: string }) => void,
  ) => void;

  // (Re)lance la connexion d'un compte existant (ex: régénérer le QR).
  'wa:account-connect': (
    input: { accountId: string },
    ack: (res: { ok: boolean }) => void,
  ) => void;

  // Renomme / recolore un compte.
  'wa:account-rename': (
    input: { accountId: string; label?: string; color?: string },
    ack: (res: { ok: boolean }) => void,
  ) => void;

  // Supprime un compte (déliaison + purge de ses données). Interdit sur 'default'.
  'wa:account-delete': (
    input: { accountId: string },
    ack: (res: { ok: boolean; error?: string }) => void,
  ) => void;

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
