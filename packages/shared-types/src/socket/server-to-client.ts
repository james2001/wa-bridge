import type {
  WaAccountsResponse,
  WaChat,
  WaConnection,
  WaMessage,
  WaPresence,
  WaReaction,
} from '../dto/whatsapp';
import type { WaMessageStatus } from '../enums';

// Événements émis par le backend vers le client web.
export interface ServerToClientEvents {
  // Liste des comptes du pont (multi-compte). Émise à la connexion d'un client
  // et à chaque changement (ajout / suppression / renommage d'un compte).
  'wa:accounts': (p: WaAccountsResponse) => void;

  // État de la connexion WhatsApp d'UN compte (QR à afficher, lié, déconnecté…).
  // Le compte concerné est porté par `conn.accountId`.
  'wa:connection': (conn: WaConnection) => void;

  // Lot de discussions (sync initiale ou mise à jour groupée).
  'wa:chats': (p: { accountId: string; chats: WaChat[] }) => void;

  // Création/mise à jour d'une discussion (nouveau dernier message, unread…).
  'wa:chat-upsert': (p: { accountId: string; chat: WaChat }) => void;

  // Une communauté a changé (création / renommage) : le client refetch la liste.
  'wa:community': (p: { accountId: string }) => void;

  // Nouveau message (entrant ou écho d'un envoi).
  'wa:message': (p: { accountId: string; message: WaMessage }) => void;

  // Mise à jour du statut d'un message (sent/delivered/read…).
  'wa:message-status': (p: {
    accountId: string;
    id: string;
    chatJid: string;
    status: WaMessageStatus;
  }) => void;

  // Message révoqué/supprimé pour tout le monde (typé, non émis aujourd'hui).
  'wa:message-deleted': (p: {
    accountId: string;
    id: string;
    chatJid: string;
  }) => void;

  // Réactions mises à jour sur un message (état complet, remplace).
  'wa:reaction': (p: {
    accountId: string;
    chatJid: string;
    messageId: string;
    reactions: WaReaction[];
  }) => void;

  // Présence d'un contact (online, en train d'écrire…). accountId via le DTO.
  'wa:presence': (p: WaPresence) => void;

  // L'historique d'une discussion (ou global) vient d'être synchronisé.
  'wa:history-synced': (p: { accountId: string; chatJid: string | null }) => void;
}
