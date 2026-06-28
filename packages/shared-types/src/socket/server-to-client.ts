import type {
  WaChat,
  WaConnection,
  WaMessage,
  WaPresence,
  WaReaction,
} from '../dto/whatsapp';
import type { WaMessageStatus } from '../enums';

// Événements émis par le backend vers le client web.
export interface ServerToClientEvents {
  // État de la connexion WhatsApp (QR à afficher, lié, déconnecté…).
  'wa:connection': (conn: WaConnection) => void;

  // Lot de discussions (sync initiale ou mise à jour groupée).
  'wa:chats': (p: { chats: WaChat[] }) => void;

  // Création/mise à jour d'une discussion (nouveau dernier message, unread…).
  'wa:chat-upsert': (p: { chat: WaChat }) => void;

  // Nouveau message (entrant ou écho d'un envoi).
  'wa:message': (p: { message: WaMessage }) => void;

  // Mise à jour du statut d'un message (sent/delivered/read…).
  'wa:message-status': (p: {
    id: string;
    chatJid: string;
    status: WaMessageStatus;
  }) => void;

  // Message révoqué/supprimé pour tout le monde.
  'wa:message-deleted': (p: { id: string; chatJid: string }) => void;

  // Réactions mises à jour sur un message (état complet, remplace).
  'wa:reaction': (p: {
    chatJid: string;
    messageId: string;
    reactions: WaReaction[];
  }) => void;

  // Présence d'un contact (online, en train d'écrire…).
  'wa:presence': (p: WaPresence) => void;

  // L'historique d'une discussion (ou global) vient d'être synchronisé.
  'wa:history-synced': (p: { chatJid: string | null }) => void;
}
