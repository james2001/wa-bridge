import type {
  ConnectionState,
  WaMessageType,
  WaMessageStatus,
  PresenceKind,
} from '../enums';

// Identifiant du compte historique unique. Source de vérité partagée front/back :
// défaut des DTO/handlers et des inputs socket sans accountId (rétro-compat).
export const DEFAULT_ACCOUNT_ID = 'default';

// Un compte WhatsApp lié au pont (multi-compte). Phase 1: un seul, id 'default'.
export interface WaAccount {
  id: string; // identifiant stable ('default' = compte historique unique)
  label: string; // nom affichable choisi par l'utilisateur
  color: string | null; // couleur d'accent UI (badge/onglet), ex. '#25D366'
  phoneJid: string | null; // JID du compte lié (null tant que non lié)
  status: ConnectionState; // réutilise l'enum de connexion
  isDefault: boolean; // true pour le compte 'default'
  sortOrder: number; // ordre d'affichage
}

// GET /api/wa/accounts -> liste des comptes du pont.
export interface WaAccountsResponse {
  accounts: WaAccount[];
  defaultAccountId: string; // toujours 'default' en Phase 1
}

// État de la connexion WhatsApp (Baileys).
export interface WaConnection {
  accountId: string; // compte propriétaire
  state: ConnectionState;
  qr: string | null; // chaîne brute du QR à afficher (quand state === 'qr')
  me: { jid: string; name: string | null } | null; // quand state === 'open'
}

// Contact / interlocuteur (JID WhatsApp: ...@s.whatsapp.net ou ...@g.us).
export interface WaContact {
  accountId: string; // compte propriétaire
  jid: string;
  name: string | null; // nom enregistré, sinon pushName / notify
  isGroup: boolean;
  avatarUrl: string | null;
}

// Une discussion dans la liste.
export interface WaChat {
  accountId: string; // compte propriétaire
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTs: number | null; // epoch ms
  lastMessagePreview: string | null;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  blocked: boolean; // contact bloqué (1:1 ; toujours false pour un groupe)
  avatarUrl: string | null;
}

// GET /api/wa/contacts/:jid/about -> bio/statut « À propos » d'un contact.
export interface WaContactAbout {
  status: string | null; // texte « À propos » (null si masqué/indispo)
  setAt: number | null; // epoch ms de dernière mise à jour, si connu
}

// Métadonnées média (téléchargement paresseux via le backend).
export interface WaMediaInfo {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string | null;
  fileName: string | null;
  caption: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  ptt: boolean; // note vocale
  sizeBytes: number | null;
  // URL servie par le backend (média déchiffré à la demande). Null tant que non demandé.
  url: string | null;
  thumbnailBase64: string | null; // miniature/preview légère
}

// Une réaction (emoji) posée sur un message par un participant.
export interface WaReaction {
  emoji: string;
  senderJid: string | null; // qui a réagi (null = inconnu)
  fromMe: boolean;
}

// Un message WhatsApp normalisé pour l'UI.
export interface WaMessage {
  accountId: string; // compte propriétaire
  id: string; // id du message WhatsApp
  chatJid: string;
  fromMe: boolean;
  senderJid: string | null; // expéditeur réel (utile en groupe)
  senderName: string | null;
  type: WaMessageType;
  text: string | null; // corps texte ou légende média
  timestamp: number; // epoch ms
  status: WaMessageStatus;
  quotedId: string | null; // message cité (réponse)
  media: WaMediaInfo | null;
  reactions: WaReaction[]; // réactions emoji posées sur ce message
  clientId: string | null; // corrélation avec l'écho optimistic
}

// --- REST ---

// GET /api/wa/status
export type WaStatusResponse = WaConnection;

// GET /api/wa/chats
export interface WaChatsResponse {
  chats: WaChat[];
}

// GET /api/wa/chats/:jid/messages?before=&limit=
export interface WaMessagesPage {
  messages: WaMessage[]; // ordre chronologique croissant
  hasMore: boolean;
  nextBefore: number | null; // timestamp à passer pour la page suivante
}

// Accusé de réception d'un message sortant, par destinataire
// (panneau « Infos du message »). Les horodatages sont en epoch ms, null si
// l'étape n'a pas (encore) eu lieu.
export interface WaMessageReceipt {
  userJid: string; // destinataire (JID canonicalisé)
  name: string | null; // nom affichable (carnet/pushName), sinon null
  deliveredAt: number | null; // distribué
  readAt: number | null; // lu
  playedAt: number | null; // écouté (note vocale / audio)
}

// GET /api/wa/chats/:jid/messages/:id/info
// Détail des accusés d'un message SORTANT (vide pour un message entrant).
export interface WaMessageInfoResponse {
  accountId: string; // compte propriétaire
  id: string;
  chatJid: string;
  isGroup: boolean;
  sentAt: number; // epoch ms — envoi
  receipts: WaMessageReceipt[];
}

// Un élément média d'une discussion (galerie « Médias, liens et documents »).
export interface WaMediaItem {
  accountId: string; // compte propriétaire
  id: string; // id du message
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string | null;
  fileName: string | null;
  caption: string | null;
  url: string | null; // /api/wa/media/<chatJid>/<id> (servi par le backend, token ?t=)
  thumbnailBase64: string | null;
  timestamp: number; // epoch ms
  fromMe: boolean;
}

// GET /api/wa/chats/:jid/media -> tous les médias d'une discussion (récents d'abord).
export interface WaChatMediaResponse {
  items: WaMediaItem[];
}

// Présence d'un contact.
export interface WaPresence {
  accountId: string; // compte propriétaire
  jid: string;
  kind: PresenceKind;
  at: number; // epoch ms
}
