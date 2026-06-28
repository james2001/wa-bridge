import type {
  ConnectionState,
  WaMessageType,
  WaMessageStatus,
  PresenceKind,
} from '../enums';

// État de la connexion WhatsApp (Baileys).
export interface WaConnection {
  state: ConnectionState;
  qr: string | null; // chaîne brute du QR à afficher (quand state === 'qr')
  me: { jid: string; name: string | null } | null; // quand state === 'open'
}

// Contact / interlocuteur (JID WhatsApp: ...@s.whatsapp.net ou ...@g.us).
export interface WaContact {
  jid: string;
  name: string | null; // nom enregistré, sinon pushName / notify
  isGroup: boolean;
  avatarUrl: string | null;
}

// Une discussion dans la liste.
export interface WaChat {
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTs: number | null; // epoch ms
  lastMessagePreview: string | null;
  pinned: boolean;
  archived: boolean;
  avatarUrl: string | null;
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

// Présence d'un contact.
export interface WaPresence {
  jid: string;
  kind: PresenceKind;
  at: number; // epoch ms
}
